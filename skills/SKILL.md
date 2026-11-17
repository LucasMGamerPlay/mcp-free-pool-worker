---
name: free-pool-worker
description: Delegates mechanical, verifiable coding subtasks (tests, boilerplate, docs, i18n, log analysis) to a pool of free/local LLM providers with automatic failover. Use when a task is narrow enough to check with build, lint or a test, and you want to save tokens by not doing it yourself.
---

# Protocolo de Orquestração de Sub-Agentes (MCP Free-Pool)

Você opera como **Arquiteto Principal e Gerente de Engenharia**. O servidor MCP `free-pool-worker` conecta você a uma fazenda de modelos gratuitos e locais. Ele faz failover, cooldown e validação — você define a tarefa e verifica o resultado.

## Quando Delegar

Delegue quando a tarefa for **mecânica e o resultado for verificável automaticamente** (build passa, lint limpo, teste verde, arquivo novo). Se não houver como verificar sem ler tudo, faça você mesmo — delegar sem verificação custa mais caro que escrever.

Bom para: testes unitários, boilerplate e tipos, schemas JSON/Zod, JSDoc/README, tradução de strings, resumo de logs longos, renomeações mecânicas.
Não delegue: decisões de arquitetura, security review, debugging que exige raciocínio sobre o sistema inteiro.

## Ferramentas

| Ferramenta | Para quê |
| :--- | :--- |
| `delegate_task` | Recebe a saída como preview de 30 linhas + caminho de um arquivo temporário com o texto completo. |
| `delegate_and_write` | Mesmo fluxo, mas o servidor valida e grava em `output_file_path` (relativo à raiz do workspace). |
| `worker_pool_status` | Estado ao vivo do pool: por provedor **e por modelo** (cooldown, motivo da desabilitação), tokens economizados e a **ordem de roteamento** de cada `task_type`. |

Parâmetros comuns:

* `task_type`: `coding` \| `tests` \| `docs` \| `analysis` \| `refactor` — define a ordem dos provedores (coding/tests priorizam velocidade; analysis prioriza contexto).
* `role_instruction`: a persona do worker (ex.: "Senior TypeScript engineer que escreve Vitest").
* `task_description`: instrução exata e estreita. Diga quais funções testar, qual padrão seguir e o formato de saída.
* `context_files`: caminhos relativos ao workspace. O servidor lê do disco — **nunca cole conteúdo de arquivo aqui**.
* `deadline_ms`: teto do loop inteiro de fallback (padrão 90000, máximo 300000).
* `max_output_tokens`: padrão 4096, máximo 16000. Suba isso para arquivos grandes.
* `output_file_path` / `overwrite` (só `delegate_and_write`): se o destino já existe e `overwrite` não for `true`, o servidor grava em `<arquivo>.bak` e deixa o original intacto.

## Contrato de Retorno

* `provider: X | model: Y | lines: N` — quem respondeu. Se aparecer `fell back after ...`, a resposta veio de um plano B: verifique com mais rigor (rode os testes). `failed attempt(s)` são erros reais; `provider(s) skipped` são provedores que nem foram chamados (sem chave, em cooldown ou sem contexto suficiente).
* `validation: ok` (sintaxe conferida: TS/JS/JSON com parser, YAML, Python quando há interpretador) ou `skipped (sem validador para a extensão)` — nesse caso a checagem é sua.
* Falha total devolve a lista de tentativas (`no-key`, `cooldown`, `http`, `timeout`, `network`, `context`, `truncated`, `invalid`). Se a mensagem disser **"unusable output"** ou mostrar **"rejected as unusable"**, o problema é o prompt ou o limite de tokens, não a disponibilidade: os provedores responderam, o conteúdo é que não passou. Em `delegate_and_write` a mensagem inclui o preview da última saída rejeitada.

## Regras de Ouro

1. **Um trabalho por chamada.** Duas responsabilidades no mesmo prompt produzem saída pela metade.
2. **Verifique de verdade:** rode `lint`/`build`/teste no resultado. A validação do servidor é só sintaxe, não corretude de negócio.
3. **Validação falhou = nada foi gravado.** O pool já tentou os outros modelos e provedores antes de desistir, então repetir o mesmo prompt tende a repetir o erro: corrija a instrução ou o `max_output_tokens` antes de chamar de novo.
4. **Nunca delegue segredos.** `.env`, chaves, `*.pem`, `.git/` e `credentials*` são bloqueados — não conte com isso.
5. **`truncated` significa limite de tokens.** A saída foi cortada e descartada (não gravada); aumente `max_output_tokens`.
6. **`no-key` é configuração, não falha transitória.** Peça ao usuário para preencher a variável no `.env` do worker e reiniciar — cooldown não resolve isso.
7. **Depois de uma escrita, não releia o arquivo inteiro.** Confie no `lines:` e na validação; confirme com `build`/`lint`.
