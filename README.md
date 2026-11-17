# MCP Free-Pool Worker

Servidor MCP (stdio) que delega tarefas mecânicas de código a um pool de provedores gratuitos/locais, com failover por modelo, cooldown por cota e validação antes de gravar arquivos.

## Requisitos

- Node.js >= 22
- Pelo menos uma chave de provedor (Groq, Google AI Studio ou OpenRouter já verificados)

## Instalação

```powershell
git clone https://github.com/LucasMGamerPlay/mcp-free-pool-worker.git
cd mcp-free-pool-worker
npm ci
npm run build
Copy-Item .env.example .env     # preencha as chaves que você tem
npm test                        # 51 testes, inclui um E2E com provedor mockado
```

Provedores sem chave são ignorados (`no-key` no relatório) e o pool segue para o próximo.

## Registrar no cliente

Os arquivos em `examples/` estão prontos para copiar — troque o caminho do `dist/src/index.js` e o `WORKSPACE_ROOT`:

| Cliente | Arquivo | Destino |
| :--- | :--- | :--- |
| OpenCode | `examples/opencode.json` | `~/.config/opencode/opencode.jsonc` (bloco `mcp.servers`) |
| Claude Code | `examples/claude-code.mcp.json` | `.mcp.json` do projeto |
| Codex CLI | `examples/codex.toml` | `~/.codex/config.toml` |

As chaves vêm do `.env` da pasta deste projeto; variáveis definidas no `env` do cliente têm precedência. O `WORKSPACE_ROOT` é a raiz usada para resolver `context_files` e `output_file_path` — se omitido, vale o diretório atual do cliente.

No OpenCode a forma atual é `mcp.servers.<nome>` (a forma antiga, com o servidor direto dentro de `mcp`, está marcada como *deprecated* no schema). Nela não existe `enabled`: use `disabled: false` se quiser declarar explicitamente que o servidor está ativo.

## Instalar a skill do modelo gerente

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\skills\free-pool-worker"
Copy-Item skills/SKILL.md "$env:USERPROFILE\.config\opencode\skills\free-pool-worker\SKILL.md"
```

O nome da pasta **precisa** ser igual ao `name:` do frontmatter (`free-pool-worker`), senão a skill não é descoberta. Para Claude Code, o destino é `~/.claude/skills/free-pool-worker/SKILL.md`.

## Verificar que está no ar

Peça ao modelo gerente: *"chame worker_pool_status"*. Você deve ver cada provedor com `state`, `keys_available` e a lista de `models` com o respectivo estado — além de `workspace_root`, `config_file` e `state_file`, que respondem "qual raiz, qual config e onde ficam os cooldowns". Para um teste ponta a ponta, use `delegate_task` com `task_type: coding` e `"Reply with exactly: PONG"`.

## Provedores

| Provedor | Modelos | Status |
| :--- | :--- | :--- |
| Groq | `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` | verificados |
| Google AI Studio | `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3.5-flash` | verificados |
| OpenRouter | `cohere/north-mini-code:free`, `openrouter/free`, `nvidia/nemotron-3.5-lightning:free` | verificados (429 intermitente no tier free) |
| Cerebras | `llama-3.3-70b`, `qwen-3-32b` | não verificados (sem chave) |
| GitHub Models | `openai/gpt-4.1-mini`, `openai/gpt-4o-mini` | não verificados (sem chave) |
| Local | `qwen2.5-coder-7b-instruct` | não verificado (LM Studio em `localhost:1234`) |

Modelos gratuitos mudam com frequência: confira o catálogo do provedor e edite `config/providers.json` — não é necessário recompilar.

## O que é validado antes de gravar

| Extensão | Validação |
| :--- | :--- |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs` | parser do TypeScript (`transpileModule`) |
| `.json` | `JSON.parse` |
| `.yml`, `.yaml` | parser `yaml` |
| `.py` | AST do CPython (`ast.parse`), se houver `python`/`python3`/`$PYTHON` |
| demais | nada; a resposta diz `validation: skipped` |

A checagem é **de sintaxe**. Regra de negócio continua sendo responsabilidade do `build`/`lint`/teste do seu projeto.

## Problemas comuns

| Sintoma | Causa | Ação |
| :--- | :--- | :--- |
| `no-key` | variável ausente no `.env` | preencher e reiniciar o servidor |
| `cooldown` | cota/rate limit do modelo | esperar; o cooldown fica salvo em `~/.cache/mcp-free-pool/state.json` |
| `truncated` | a saída estourou `max_output_tokens` | aumentar o parâmetro (máx. 16000) |
| `invalid` | saída não passou na validação de sintaxe | o pool já tentou os outros modelos; corrigir a instrução |
| `network` (local) | LM Studio/Ollama não está rodando | subir o servidor local ou remover o provedor |

## Licença

MIT — veja [LICENSE](LICENSE).
