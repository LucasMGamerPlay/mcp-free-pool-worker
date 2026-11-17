# Plano de Arquitetura e Implementação: MCP Free-Pool Worker

## 1. Visão Geral do Projeto

O **MCP Free-Pool Worker** é um sistema composto por um **Servidor MCP (Model Context Protocol)** acoplado a uma **Skill de Orquestração (`SKILL.md` / `AGENTS.md`)** para assistentes de codificação como OpenCode, Claude Code, Cursor e Codex CLI.

O objetivo central é estabelecer uma arquitetura **Gerente-Trabalhador (Manager-Worker)** onde o modelo principal (mais caro ou com limites rígidos de uso) atua exclusivamente como arquiteto e revisor, delegando tarefas volumosas ou mecânicas para uma fila inteligente de modelos gratuitos em nuvem e modelos locais, com *failover* automático e transparente.

## 2. Objetivos Principais

* **Economia Drástica de Tokens no Modelo Principal:** Evitar que o modelo gerente leia ou escreva centenas de linhas de código repetitivo (testes, *boilerplates*, traduções, refatorações isoladas e documentações).
* **Leitura e Escrita Out-of-Band (Fora da Banda):** O servidor MCP lê os arquivos de contexto diretamente do disco local e os injeta no prompt do sub-modelo gratuito, poupando os tokens de saída (*output tokens*) do modelo gerente.
* **Resiliência Zero-Downtime (Circuit Breaker):** Quando um provedor gratuito atinge o limite de requisições (`HTTP 429`), sofre queda (`HTTP 5xx`) ou estoura o tempo limite (*timeout*), o roteador suspende esse provedor temporariamente e redireciona a tarefa no mesmo instante para o próximo modelo da fila.
* **Compatibilidade Universal:** Funcionar em qualquer cliente compatível com o protocolo MCP via transporte `stdio`.

## 3. Arquitetura em 3 Camadas

### Camada 1: Diretriz do Agente Gerente (Skill / System Prompt)
Instruções injetadas via `AGENTS.md`, `CLAUDE.md` ou `SKILL.md` que condicionam o modelo principal a identificar tarefas delegáveis, formular instruções cirúrgicas e acionar a ferramenta MCP em vez de gerar blocos extensos de código por conta própria.

### Camada 2: Servidor MCP e Injetor de Contexto Local
Camada intermediária em Node.js/TypeScript (ou Rust) que expõe ferramentas padronizadas ao agente principal:
* Recebe apenas metadados da tarefa e caminhos de arquivos (`context_files`).
* Faz a leitura física dos arquivos no sistema operacional (`fs.readFile`), **somente dentro de uma raiz de trabalho explícita** (`workspace_root`), com allowlist de caminhos e bloqueio de arquivos sensíveis.
* Monta o pacote de contexto completo e o envia para a camada de roteamento.
* Grava a saída diretamente em disco (`delegate_and_write`). Quando não houver arquivo de destino, salva a resposta em um arquivo temporário e devolve ao gerente apenas um preview curto e o caminho — nunca o conteúdo inteiro.

### Camada 3: Engine de Roteamento e Circuit Breaker (Pool de Provedores)
Gerenciador de fila priorizada que normaliza todas as chamadas sob o padrão OpenAI-compatible (`/v1/chat/completions`) e controla o estado de saúde de cada provedor e chave de API.

## 4. Topologia do Pool de Provedores Gratuitos

Os provedores são organizados por especialidade da tarefa e prioridade de execução:

| Prioridade | Provedor | Modelos Recomendados | Ponto Forte | Tratamento de Limite |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Groq Cloud** | `qwen-2.5-coder-32b`, `llama-3.3-70b` | Velocidade extrema ($>300$ tok/s) | Cooldown curto ($60\text{s}$ por RPM) |
| **2** | **Cerebras / SambaNova** | `llama-3.3-70b`, `qwen-2.5-coder` | Baixíssima latência para código | Cooldown curto ($60\text{s}$ por RPM) |
| **3** | **Google AI Studio** | `gemini-2.5-flash`, `gemini-2.5-pro` | Janela de contexto massiva ($1\text{M}$ tokens) | Cooldown médio ($60\text{s}$ a $300\text{s}$) |
| **4** | **OpenRouter (`:free`)** | `deepseek-chat:free`, `qwen-coder:free` | Grande variedade de modelos abertos | Rotação imediata de modelo |
| **5** | **GitHub Models** | `gpt-4o-mini`, `o3-mini` (Free tier) | Alta precisão em instruções complexas | Cooldown longo (limite por hora/dia) |
| **6** | **Local (LM Studio / Ollama)** | `qwen2.5-coder`, `devstral`, `nemotron` | Sem limites de cota e $100\%$ privado | Fallback final garantido |

> **Nomes de modelo e limites mudam com frequência.** Esta tabela é referência inicial, não fonte de verdade. Na implementação, confirme cada modelo na documentação oficial e mantenha os valores em `config/providers.json`, com os campos: `id`, `provider`, `base_url`, `model`, `env_key` (ou `env_keys[]`), `max_context`, `max_output`, `rpm`, `cooldown_short_s`, `cooldown_daily_s`, `priority_by_task_type`.

## 5. Máquina de Estados do Circuit Breaker

Para evitar desperdício de tempo tentando chamar APIs que já estouraram o limite, o pool mantém dois níveis de circuito: por provedor e por modelo. A classificação do erro define qual dos dois abre:

**Escopo do circuito:** `401/403` e falha de rede afetam a **key/provedor inteiro**; `429/402`, `5xx` e timeout afetam **apenas o modelo**. Assim, um `429` em um modelo free do OpenRouter não bloqueia os outros modelos do mesmo provedor — o roteador tenta o próximo modelo da lista antes de cair para o próximo serviço.

| Resposta | Ação |
| :--- | :--- |
| `401` e `403` de chave inválida/revogada | Desabilita a key (ou o provedor, se tiver uma só) **permanentemente** e expõe o motivo em `worker_pool_status`. Não é cooldown — repetir não resolve. |
| `429` (rate limit) | Vai para `OPEN` com cooldown curto — **apenas o modelo**, os outros modelos do provedor seguem elegíveis. |
| `402` (cota esgotada) | Vai para `OPEN` com cooldown longo (1 h) — **apenas o modelo**. Cota diária não volta em um minuto, então repetir só martela o serviço. |
| `5xx`, timeout | Vai para `OPEN` com cooldown curto — **apenas o modelo**. |
| Erro de conexão/DNS | Vai para `OPEN` com cooldown curto — **o provedor inteiro**, já que nenhum modelo dele responde. |
| `404`, ou `400` cujo corpo diga que o modelo não existe/não é válido | Slug morto (saiu do catálogo ou foi digitado errado): cooldown longo (1 h) **apenas no modelo**, para não pagar o mesmo erro em toda tarefa. Não derruba o provedor. |
| `400`, `422` de payload (ex.: `max_tokens` alto demais) | Não é falha do provedor nem do modelo: aborta a tentativa nele e registra erro de configuração. Não entra em cooldown. |

1. **Estado `CLOSED` (Saudável):** O provedor está apto a receber requisições.
2. **Estado `OPEN` (Em Cooldown):** Acionado pela tabela acima.
   * Se vier `Retry-After` (segundos ou HTTP-date) ou `x-ratelimit-reset-requests`, o bloqueio é calculado a partir do header. Atenção: formatos como `1m2.4s` exigem parser dedicado — sem ele o cooldown vira `0` e o provedor é martelado de novo.
   * Sem header, aplica-se *exponential backoff* iniciando em $60\text{ s}$ (rate limit) ou $3600\text{ s}$ (cota diária).
3. **Estado `HALF-OPEN` (Recuperação):** Quando $T_{\text{atual}} > T_{\text{cooldown}}$, o provedor vai para `HALF-OPEN` e libera **uma única requisição de sondagem**. Sucesso → volta a `CLOSED` e zera o contador; falha → volta a `OPEN` com cooldown dobrado. Enquanto a sondagem não retorna, as demais chamadas seguem para o próximo da fila (evita thundering herd no fim do cooldown).

## 6. Especificação das Ferramentas MCP (Tool Schemas)

O servidor MCP expõe três ferramentas principais para o modelo gerente:

### 6.1. `delegate_task`
Executa uma subtarefa isolada lendo arquivos locais diretamente pelo servidor MCP e retorna o resultado ao modelo gerente.

* **Parâmetros de Entrada:**
  * `task_type` (`"coding" | "tests" | "docs" | "analysis" | "refactor"`): Define qual fila de modelos terá prioridade (ex: tarefas `"analysis"` com muitos arquivos priorizam Google AI Studio pela janela de contexto; `"coding"` prioriza Groq/Cerebras pela velocidade).
  * `role_instruction` (`string`): Papel do trabalhador (ex: *"Especialista em TypeScript e testes unitários com Vitest"*).
  * `task_description` (`string`): Instrução clara e restrita do que o sub-modelo deve produzir.
  * `context_files` (`string[]`): Caminhos dos arquivos que o MCP deve ler do disco e anexar ao prompt. Sempre relativos a `workspace_root`; caminhos fora da raiz ou em padrão bloqueado são rejeitados.
  * `deadline_ms` (`number`, opcional, padrão `90000`): teto de tempo do loop completo de fallback, não por provedor.
  * `max_output_tokens` (`number`, opcional): limite de saída do worker.

* **Retorno:** o conteúdo completo é salvo em um arquivo temporário; a resposta ao gerente traz o caminho, a contagem de linhas e um preview de no máximo ~30 linhas. O gerente só abre o arquivo se precisar revisar.

### 6.2. `delegate_and_write`
Ideal para criação de novos arquivos (como suítes de teste completas ou documentação). O sub-modelo gera o conteúdo e o próprio servidor MCP salva no arquivo de destino, retornando ao modelo gerente apenas uma confirmação de sucesso e o resumo das linhas escritas.

* **Parâmetros de Entrada:**
  * Mesmos parâmetros de `delegate_task` acrescidos de `output_file_path` (`string`).
  * `overwrite` (`boolean`, padrão `false`): se o destino já existe e `overwrite` não for `true`, o servidor grava em `output_file_path.bak` e retorna aviso — nunca sobrescreve silenciosamente.
* **Validação antes de gravar:** o conteúdo passa pelo `validator.ts` conforme a extensão (`.ts`: `tsc --noEmit` ou parser; `.json`: `JSON.parse`; `.md`: sem validação). Se falhar, o arquivo não é gravado e o erro volta ao gerente com o preview.
* **Sanitização:** remove cercas de markdown e texto conversacional antes da validação.
* **Retorno:** caminho gravado, contagem de linhas/diff resumido e status da validação. O gerente roda `lint`/`build` no fim como confirmação final.

### 6.3. `worker_pool_status`
Retorna o relatório em tempo real de todos os provedores cadastrados (quais estão ativos, quais estão em *cooldown*, tempo restante de bloqueio e total de tokens economizados na sessão).

### 6.4. Regras Transversais (Segurança, Tempo, Concorrência)

* **Segurança de caminhos:** toda leitura e escrita passa por `safePath.ts`. A raiz é `workspace_root` (configurável, padrão = diretório do projeto). Rejeitar caminhos absolutos fora da raiz, `..` que escape e padrões bloqueados: `.env*`, `*.pem|key|p12|pfx|crt|jks|keystore|kdbx`, `.git/`, `id_rsa*`, `credentials*`, `secrets*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`, `.aws/`, `.docker/`, `.ssh/`, `terraform.tfstate*`. **Links simbólicos são resolvidos**: na leitura vale o caminho real do arquivo; na escrita vale o caminho real do ancestral existente mais próximo. Assim um repositório com link para fora da raiz não lê nem grava nada. O contexto sai do disco local para APIs de terceiros — a allowlist é obrigatória.
* **Logging:** stdout do processo é o canal JSON-RPC do transporte `stdio`. Todo log vai para `stderr` (ou arquivo). Um `console.log` perdido derruba a conexão com o cliente.
* **Deadline total:** cada chamada de tool respeita `deadline_ms` como teto do loop inteiro de fallback, incluindo o tempo parado na fila do provedor (o timeout da tentativa é recalculado ao sair da fila, não antes). Ao estourar, retorna erro claro com o estado de cada provedor tentado. Estouro de orçamento não coloca o modelo em cooldown: não é evidência de lentidão.
* **Concorrência:** no máximo 1 requisição em voo por provedor (fila interna). Chamadas paralelas do gerente não multiplicam o consumo de RPM.
* **Limite de saída:** `max_output_tokens` por chamada, configurável em `providers.json`. Se o provedor sinalizar corte por limite (`finish_reason: length`), a resposta é **descartada** como `truncated` e o roteador tenta o próximo modelo — código cortado pode passar na validação de sintaxe e corromper o arquivo gravado.

## 7. Estrutura de Diretórios do Projeto

```text
mcp-free-pool-worker/
├── package.json
├── tsconfig.json
├── README.md                   # instalação, registro nos clientes, problemas comuns
├── .env.example                # Chaves das APIs gratuitas e portas locais
├── config/
│   └── providers.json          # Lista de provedores, modelos, pesos e limites
├── examples/                   # opencode.json, claude-code.mcp.json, codex.toml
├── src/
│   ├── index.ts                # Inicialização do Servidor MCP (StdioTransport) + leitura do .env
│   ├── tools/
│   │   ├── delegateTask.ts     # Handler da ferramenta delegate_task
│   │   ├── delegateWrite.ts    # Handler da ferramenta delegate_and_write
│   │   ├── poolStatus.ts       # Handler de diagnóstico do pool
│   │   └── response.ts         # Formato de retorno (ok/fail) e aviso de fallback
│   ├── router/
│   │   ├── circuitBreaker.ts   # Controle de estados, cooldown e retry-after
│   │   ├── keyRotator.ts       # Suporte a múltiplas API keys por provedor
│   │   ├── stateStore.ts       # Persistência atômica dos cooldowns
│   │   └── dispatcher.ts       # Chamadas HTTP unificadas, roteamento e fallback loop
│   └── utils/
│       ├── fileReader.ts       # Leitura de context_files dentro do workspace_root
│       ├── safePath.ts         # resolve + realpath + bloqueio de segredos
│       ├── validator.ts        # JSON.parse / parser TS antes de gravar
│       ├── codeFence.ts        # Remove cercas de markdown conforme a extensão
│       ├── logger.ts           # log exclusivo em stderr (stdout é o canal JSON-RPC)
│       └── tokenCounter.ts     # Estimativa de tokens economizados pelo gerente
├── tests/                      # 13 arquivos, node:test contra dist/ (ver package.json)
└── skills/
    └── SKILL.md                # Instruções prontas para Claude Code / OpenCode / Codex
```

## 8. Skill do Modelo Gerente

O conteúdo canônico está em [`skills/SKILL.md`](skills/SKILL.md) — é esse arquivo que se instala no cliente, e ele é a única fonte de verdade. Este documento não o duplica, para não divergir (a versão antiga duplicada aqui já estava desatualizada: não citava `.bak`, contrato de retorno nem os status de falha).

Invariantes que qualquer versão da skill deve manter:

1. Delegar só o que é **verificável automaticamente** (build, lint, teste, arquivo novo).
2. Passar contexto por **caminho** (`context_files`), nunca colando conteúdo.
3. Verificar o resultado no projeto; a validação do servidor cobre **sintaxe**, não negócio.
4. Nunca pedir segredos — a blocklist do servidor é a última linha de defesa, não a primeira.
5. Tratar `fell back`, `truncated`, `invalid` e `no-key` como sinais diferentes, cada um com uma ação própria.

## 9. Recursos Avançados Implementados

* **Rotação Multi-Chave (Multi-Key Pool):** implementado. Cadastre um array de chaves por provedor (`env_keys`, ex.: `GROQ_API_KEYS=key1,key2`). Um `429`/`402` gira para a próxima chave; um `401/403` mata só aquela chave. O provedor só é desabilitado quando todas morrem.
* **Roteamento por Tamanho de Contexto:** O módulo `fileReader.ts` calcula o tamanho total dos `context_files` antes do envio. O roteador compara `entrada + max_output` com o `max_context` do provedor — a resposta também precisa caber — e ignora automaticamente quem não comporta, em vez de tomar um `400` garantido.
* **Limpeza Automática de Markdown:** Caso a ferramenta `delegate_and_write` seja usada, um pós-processador remove blocos de marcação (` ```typescript ... ``` `) deixados pelo sub-modelo antes de salvar o código puro no disco.
* **Estado persistente do pool:** os cooldowns de provedor **e de modelo** são salvos em `~/.cache/mcp-free-pool/state.json` (ou `FREE_POOL_STATE`) e restaurados no start, então reiniciar não martela provedores que ainda estão em cooldown. Escrita atômica (temp + rename), falha de cache nunca derruba uma delegação. Chaves desabilitadas por 401/403 não são persistidas de propósito, para que corrigir a chave e reiniciar resolva.

## 10. Roadmap: estado real

| Fase | Item | Estado |
| :--- | :--- | :--- |
| 1.1 | Projeto Node/TypeScript com `@modelcontextprotocol/sdk` | ✅ |
| 1.2 | `logger.ts` (stderr), `safePath.ts` (realpath + blocklist) e `fileReader.ts` com `workspace_root` | ✅ |
| 1.3 | `dispatcher.ts` + `circuitBreaker.ts`: 401/403, 429, 402, 5xx, timeout, rede, `HALF-OPEN` com sondagem única, `Retry-After`, `deadline_ms` (incluindo fila) e 1 request em voo por provedor | ✅ |
| 1.4 | `delegate_task` / `delegate_and_write` com `.bak`, `overwrite`, validação com failover e preview da saída rejeitada | ✅ |
| 1.5 | Testes de `circuitBreaker` e `safePath` | ✅ |
| 2.1 | Roteamento por `task_type` + contexto (`entrada + max_output` vs `max_context`) | ✅ |
| 2.2 | `worker_pool_status`: provedor, modelo, cooldown, motivo, tokens, routing e ambiente | ✅ |
| 2.3 | `validator.ts` | ✅ TS/JS/JSON com parser, YAML com `yaml`, Python via AST do CPython quando há interpretador; as demais extensões reportam `skipped` em vez de fingir validação |
| 3.1 | `providers.json` versionado e validado na inicialização | ✅ |
| 3.2 | Integração nos clientes | ⚠️ exemplos e carregamento do `.env` do worker validados; o registro no OpenCode/Claude Code/Codex **não** foi executado |
| 3.3 | `SKILL.md` alinhada ao comportamento real | ✅ |
| 3.4 | Persistência de cooldowns (provedor e modelo) | ✅ |

## 11. Estado Atual Verificado (nov/2026)

* **Provedores confirmados por chamada real:** Groq, Google AI Studio, OpenRouter. Cerebras, GitHub Models e local continuam com modelos não verificados (sem chave/servidor).
* **Testes:** 51 casos via `node --test` sobre `dist/`, incluindo E2E por stdio contra um provedor HTTP mockado.
* **Garantias cobertas por teste:** failover por modelo, rotação de chaves, cooldown de cota (402), slug morto (400/404), truncamento, saída inválida, deadline com fila, symlink para fora da raiz, escrita que não deve acontecer em falha de validação.
* **O que não é garantido:** corretude semântica do código gerado (só sintaxe), qualidade dos modelos gratuitos e disponibilidade dos provedores.