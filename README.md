# classroom-aluno-mcp

Servidor MCP remoto do Google Classroom, escrito na perspectiva de **aluno**, não de professor. Roda como serviço HTTP e se conecta ao Claude como conector customizado — mesmo formato do seu MCP do Sigaa.

## Tools

| Tool | O que faz |
|---|---|
| `listar_cursos` | Turmas em que você está matriculado. Ponto de partida para pegar os `courseId`. |
| `proximas_entregas` | **A principal.** Varre todas as turmas ativas e devolve o que falta entregar, ordenado por prazo, marcando as atrasadas. |
| `listar_tarefas` | Tarefas publicadas de uma turma. |
| `detalhar_tarefa` | Enunciado completo, anexos, prazo e o estado da sua entrega. |
| `minhas_entregas` | Suas entregas numa turma, com estado e nota. |
| `minhas_notas` | Boletim da turma: cada tarefa × sua nota × valor, com total do que já foi corrigido. |
| `listar_avisos` | Mural da turma. |
| `listar_materiais` | Slides, PDFs e links que não valem nota. |
| `listar_topicos` | Unidades em que a turma está dividida. |
| `listar_professores` | Quem leciona. |
| `buscar` | Busca textual em tarefas, avisos e materiais de todas as turmas ao mesmo tempo. |

Com `ENABLE_TURN_IN=true` aparecem também `entregar_tarefa` e `cancelar_entrega`. Ficam desligadas por padrão — sem elas os escopos são 100% de leitura e nada no seu Classroom pode ser alterado.

## Setup

### 1. Google Cloud

1. Em [console.cloud.google.com](https://console.cloud.google.com), crie um projeto.
2. **APIs e serviços → Biblioteca → Google Classroom API → Ativar**.
3. **Tela de permissão OAuth**: tipo Externo, adicione seu próprio e-mail em *Usuários de teste*. Não precisa publicar nem passar por verificação enquanto for só você.
4. **Credenciais → Criar credenciais → ID do cliente OAuth → App para computador**. Guarde o Client ID e o Client Secret.

### 2. Gerar o refresh token (uma vez, local)

```bash
git clone <seu-fork> && cd classroom-aluno-mcp
npm install
cp .env.example .env      # preencha CLIENT_ID e CLIENT_SECRET
node auth.js
```

Abra a URL impressa, autorize, e o terminal cospe o `GOOGLE_REFRESH_TOKEN`.

Se quiser as tools de entrega, rode `ENABLE_TURN_IN=true node auth.js` — os escopos pedidos mudam.

### 3. Gerar o segredo da URL

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 4. Railway

Suba o repositório, crie o serviço e defina as variáveis:

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
MCP_SECRET
TIMEZONE=America/Recife
ENABLE_TURN_IN=false
```

Gere o domínio público. O `railway.json` já cuida de build e start; a `PORT` o Railway injeta sozinho.

### 5. Conectar no Claude

Em **Configurações → Conectores → Adicionar conector personalizado**, use:

```
https://SEU-APP.up.railway.app/mcp/SEU_MCP_SECRET
```

## Sobre a autenticação

O Classroom exige OAuth por usuário, e a UI de conectores do Claude não deixa você mandar um header customizado. A saída é o segredo no caminho da URL: sem ele, `401`. Um `Authorization: Bearer <MCP_SECRET>` também funciona, para clientes que suportem.

Isso significa que **quem tiver a URL completa tem acesso de leitura ao seu Classroom**. Trate como senha: não commite, não cole em issue, não compartilhe tela com ela aberta. Se vazar, troque a `MCP_SECRET` no Railway — a URL antiga morre na hora.

Para revogar tudo de vez, remova o app em [myaccount.google.com/permissions](https://myaccount.google.com/permissions). O refresh token para de funcionar imediatamente.

## Detalhes de implementação

- **Stateless**: cada requisição cria uma instância de servidor e transporte. Não guarda sessão, então redeploy e cold start não quebram a conexão.
- **Respostas enxutas**: as tools devolvem campos traduzidos e reduzidos em vez do JSON cru da API, que estoura o limite de tokens rápido em turma cheia.
- **Prazos**: a API do Classroom entrega data e hora em UTC separadamente. O servidor junta as duas, converte para `TIMEZONE` e devolve tanto a versão formatada quanto o ISO, além dos dias restantes.
- **`proximas_entregas`** faz duas chamadas por turma, em paralelo entre todas as turmas. Numa carga de 8 disciplinas leva 1-2 segundos.

## Limitações conhecidas

- `minhas_notas` soma pontos brutos das tarefas corrigidas. Não sabe de pesos, médias ponderadas ou da fórmula real da disciplina.
- `listar_professores` usa o escopo `rosters.readonly`. Algumas instituições restringem isso por política de domínio; se der 403, remova a tool e o escopo.
- Se o seu Classroom é de uma conta institucional, o admin pode bloquear apps OAuth não aprovados. Nesse caso o consentimento falha no passo 2 e não há contorno pelo lado do aluno.
- Anexos não são baixados, apenas listados com link. Baixar exigiria escopo de Drive, que preferi não pedir.

## Licença

MIT.
