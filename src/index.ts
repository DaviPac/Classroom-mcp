#!/usr/bin/env node
/**
 * classroom-aluno-mcp
 * Servidor MCP remoto (Streamable HTTP) para o Google Classroom,
 * na perspectiva de quem e ALUNO, nao professor.
 */
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import dotenv from "dotenv";

dotenv.config();

// ---------------------------------------------------------------- config

const PORT = Number(process.env.PORT || 3000);
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const MCP_SECRET = process.env.MCP_SECRET;
const TZ = process.env.TIMEZONE || "America/Recife";
const ENABLE_TURN_IN = process.env.ENABLE_TURN_IN === "true";

for (const [k, v] of Object.entries({
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN: REFRESH_TOKEN,
  MCP_SECRET,
})) {
  if (!v) {
    console.error(`[fatal] variavel de ambiente ausente: ${k}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- auth

let cachedAuth: OAuth2Client | null = null;

function getAuth(): OAuth2Client {
  if (!cachedAuth) {
    const c = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    c.setCredentials({ refresh_token: REFRESH_TOKEN });
    cachedAuth = c;
  }
  return cachedAuth;
}

const api = () => google.classroom({ version: "v1", auth: getAuth() });

// ---------------------------------------------------------------- helpers

function dueToDate(cw: any): Date | null {
  if (!cw?.dueDate?.year) return null;
  const { year, month, day } = cw.dueDate;
  const h = cw.dueTime?.hours ?? 23;
  const m = cw.dueTime?.minutes ?? 59;
  return new Date(Date.UTC(year, month - 1, day, h, m));
}

const fmt = (d: Date) =>
  new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);

const daysUntil = (d: Date) =>
  Math.round((d.getTime() - Date.now()) / 86_400_000);

function slimCourse(c: any) {
  return {
    id: c.id,
    nome: c.name,
    turma: c.section ?? null,
    sala: c.room ?? null,
    estado: c.courseState,
    link: c.alternateLink,
  };
}

function slimWork(w: any) {
  const d = dueToDate(w);
  return {
    id: w.id,
    titulo: w.title,
    tipo: w.workType ?? "MATERIAL",
    pontos: w.maxPoints ?? null,
    topicId: w.topicId ?? null,
    prazo: d ? fmt(d) : null,
    prazoISO: d ? d.toISOString() : null,
    link: w.alternateLink,
  };
}

function slimSubmission(s: any) {
  return {
    id: s.id,
    courseWorkId: s.courseWorkId,
    estado: s.state,
    atrasado: s.late ?? false,
    nota: s.assignedGrade ?? null,
    notaRascunho: s.draftGrade ?? null,
    anexos: (s.assignmentSubmission?.attachments ?? []).map((a: any) =>
      a.driveFile
        ? { tipo: "driveFile", nome: a.driveFile.title, link: a.driveFile.alternateLink }
        : a.link
        ? { tipo: "link", link: a.link.url }
        : { tipo: "outro" }
    ),
    link: s.alternateLink,
  };
}

const ENTREGUE = new Set(["TURNED_IN", "RETURNED"]);

async function listAll<T>(
  fn: (pageToken?: string) => Promise<{ items: T[]; next?: string }>
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const r = await fn(token);
    out.push(...r.items);
    token = r.next;
  } while (token && out.length < 500);
  return out;
}

async function meusCursos(estados: string[] = ["ACTIVE"]) {
  return listAll<any>(async (pageToken) => {
    const r = await api().courses.list({
      studentId: "me",
      courseStates: estados,
      pageSize: 100,
      pageToken,
    });
    return { items: r.data.courses ?? [], next: r.data.nextPageToken ?? undefined };
  });
}

// ---------------------------------------------------------------- tools

const TOOLS: Tool[] = [
  {
    name: "listar_cursos",
    description:
      "Lista as turmas em que voce esta matriculado como aluno. Comece por aqui para descobrir os courseId.",
    inputSchema: {
      type: "object",
      properties: {
        estados: {
          type: "array",
          items: { type: "string", enum: ["ACTIVE", "ARCHIVED", "PROVISIONED"] },
          description: "Padrao: apenas ACTIVE.",
        },
      },
    },
  },
  {
    name: "proximas_entregas",
    description:
      "A visao mais util: varre TODAS as turmas ativas e devolve as tarefas ainda nao entregues, ordenadas por prazo, incluindo as atrasadas. Use para 'o que eu tenho pra entregar'.",
    inputSchema: {
      type: "object",
      properties: {
        dias: {
          type: "number",
          description: "Janela em dias a frente. Padrao 14. Use 0 para nao limitar.",
        },
        incluirSemPrazo: {
          type: "boolean",
          description: "Incluir tarefas sem data de entrega. Padrao false.",
        },
        incluirEntregues: {
          type: "boolean",
          description: "Incluir o que ja foi entregue ou devolvido. Padrao false.",
        },
      },
    },
  },
  {
    name: "listar_tarefas",
    description: "Lista as tarefas (courseWork) publicadas de uma turma especifica.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string" },
        limite: { type: "number", description: "Padrao 50." },
      },
      required: ["courseId"],
    },
  },
  {
    name: "detalhar_tarefa",
    description:
      "Detalhe completo de uma tarefa: enunciado inteiro, anexos, criterios, prazo, e o estado da SUA entrega.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string" },
        courseWorkId: { type: "string" },
      },
      required: ["courseId", "courseWorkId"],
    },
  },
  {
    name: "minhas_entregas",
    description:
      "Suas entregas em uma turma, com estado e nota. Omita courseWorkId para trazer todas da turma.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string" },
        courseWorkId: { type: "string", description: "Opcional. Se omitido, traz todas." },
        estados: {
          type: "array",
          items: {
            type: "string",
            enum: ["NEW", "CREATED", "TURNED_IN", "RETURNED", "RECLAIMED_BY_STUDENT"],
          },
        },
      },
      required: ["courseId"],
    },
  },
  {
    name: "minhas_notas",
    description:
      "Boletim de uma turma: cruza cada tarefa com a sua nota e o valor maximo, e calcula o total obtido sobre o total possivel do que ja foi corrigido.",
    inputSchema: {
      type: "object",
      properties: { courseId: { type: "string" } },
      required: ["courseId"],
    },
  },
  {
    name: "listar_avisos",
    description: "Avisos (announcements) do mural de uma turma, do mais recente para o mais antigo.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string" },
        limite: { type: "number", description: "Padrao 20." },
      },
      required: ["courseId"],
    },
  },
  {
    name: "listar_materiais",
    description: "Materiais de apoio de uma turma (slides, PDFs, links) que nao valem nota.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string" },
        limite: { type: "number", description: "Padrao 30." },
      },
      required: ["courseId"],
    },
  },
  {
    name: "listar_topicos",
    description: "Topicos/unidades em que a turma esta organizada.",
    inputSchema: {
      type: "object",
      properties: { courseId: { type: "string" } },
      required: ["courseId"],
    },
  },
  {
    name: "listar_professores",
    description: "Quem leciona a turma.",
    inputSchema: {
      type: "object",
      properties: { courseId: { type: "string" } },
      required: ["courseId"],
    },
  },
  {
    name: "buscar",
    description:
      "Busca textual entre tarefas, avisos e materiais de todas as turmas ativas. Use quando souber o assunto mas nao a turma.",
    inputSchema: {
      type: "object",
      properties: {
        termo: { type: "string", description: "Trecho a procurar em titulos e textos." },
      },
      required: ["termo"],
    },
  },
];

if (ENABLE_TURN_IN) {
  TOOLS.push(
    {
      name: "entregar_tarefa",
      description:
        "ACAO IRREVERSIVEL NA PRATICA: marca a tarefa como entregue no Google Classroom. Confirme com o usuario antes de chamar. Nao anexa arquivos, apenas entrega o que ja estiver anexado.",
      inputSchema: {
        type: "object",
        properties: {
          courseId: { type: "string" },
          courseWorkId: { type: "string" },
        },
        required: ["courseId", "courseWorkId"],
      },
    },
    {
      name: "cancelar_entrega",
      description:
        "Desfaz uma entrega, devolvendo a tarefa para o estado de rascunho. Confirme com o usuario antes de chamar.",
      inputSchema: {
        type: "object",
        properties: {
          courseId: { type: "string" },
          courseWorkId: { type: "string" },
        },
        required: ["courseId", "courseWorkId"],
      },
    }
  );
}

// ---------------------------------------------------------------- handlers

async function chamarTool(nome: string, args: any): Promise<any> {
  const c = api();

  switch (nome) {
    case "listar_cursos": {
      const cursos = await meusCursos(args?.estados ?? ["ACTIVE"]);
      return { total: cursos.length, cursos: cursos.map(slimCourse) };
    }

    case "proximas_entregas": {
      const dias = args?.dias ?? 14;
      const incluirSemPrazo = args?.incluirSemPrazo ?? false;
      const incluirEntregues = args?.incluirEntregues ?? false;
      const cursos = await meusCursos();
      const linhas: any[] = [];

      await Promise.all(
        cursos.map(async (curso: any) => {
          const [cwRes, subRes] = await Promise.all([
            c.courses.courseWork.list({
              courseId: curso.id,
              courseWorkStates: ["PUBLISHED"],
              pageSize: 100,
            }),
            c.courses.courseWork.studentSubmissions.list({
              courseId: curso.id,
              courseWorkId: "-",
              userId: "me",
              pageSize: 200,
            }),
          ]);

          const porTarefa = new Map<string, any>();
          for (const s of subRes.data.studentSubmissions ?? []) {
            porTarefa.set(s.courseWorkId!, s);
          }

          for (const w of cwRes.data.courseWork ?? []) {
            const sub = porTarefa.get(w.id!);
            const entregue = sub && ENTREGUE.has(sub.state!);
            if (entregue && !incluirEntregues) continue;

            const d = dueToDate(w);
            if (!d && !incluirSemPrazo) continue;
            if (d && dias > 0 && daysUntil(d) > dias) continue;

            linhas.push({
              turma: curso.name,
              courseId: curso.id,
              courseWorkId: w.id,
              titulo: w.title,
              pontos: w.maxPoints ?? null,
              prazo: d ? fmt(d) : "sem prazo",
              prazoISO: d ? d.toISOString() : null,
              diasRestantes: d ? daysUntil(d) : null,
              situacao: d && daysUntil(d) < 0 ? "ATRASADA" : entregue ? sub.state : "PENDENTE",
              link: w.alternateLink,
            });
          }
        })
      );

      linhas.sort((a, b) => {
        if (!a.prazoISO) return 1;
        if (!b.prazoISO) return -1;
        return a.prazoISO < b.prazoISO ? -1 : 1;
      });

      return {
        geradoEm: fmt(new Date()),
        fusoHorario: TZ,
        turmasVarridas: cursos.length,
        total: linhas.length,
        atrasadas: linhas.filter((l) => l.situacao === "ATRASADA").length,
        tarefas: linhas,
      };
    }

    case "listar_tarefas": {
      const r = await c.courses.courseWork.list({
        courseId: args.courseId,
        courseWorkStates: ["PUBLISHED"],
        pageSize: args?.limite ?? 50,
      });
      const items = (r.data.courseWork ?? []).map(slimWork);
      items.sort((a, b) => (a.prazoISO ?? "9") < (b.prazoISO ?? "9") ? -1 : 1);
      return { total: items.length, tarefas: items };
    }

    case "detalhar_tarefa": {
      const [w, subs] = await Promise.all([
        c.courses.courseWork.get({ courseId: args.courseId, id: args.courseWorkId }),
        c.courses.courseWork.studentSubmissions.list({
          courseId: args.courseId,
          courseWorkId: args.courseWorkId,
          userId: "me",
        }),
      ]);
      const d = dueToDate(w.data);
      const sub = (subs.data.studentSubmissions ?? [])[0];
      return {
        id: w.data.id,
        titulo: w.data.title,
        enunciado: w.data.description ?? null,
        tipo: w.data.workType,
        pontos: w.data.maxPoints ?? null,
        prazo: d ? fmt(d) : null,
        diasRestantes: d ? daysUntil(d) : null,
        materiais: (w.data.materials ?? []).map((m: any) =>
          m.driveFile
            ? { tipo: "arquivo", nome: m.driveFile.driveFile?.title, link: m.driveFile.driveFile?.alternateLink }
            : m.link
            ? { tipo: "link", titulo: m.link.title, link: m.link.url }
            : m.youtubeVideo
            ? { tipo: "youtube", titulo: m.youtubeVideo.title, link: m.youtubeVideo.alternateLink }
            : m.form
            ? { tipo: "formulario", titulo: m.form.title, link: m.form.formUrl }
            : { tipo: "outro" }
        ),
        link: w.data.alternateLink,
        minhaEntrega: sub ? slimSubmission(sub) : null,
      };
    }

    case "minhas_entregas": {
      const r = await c.courses.courseWork.studentSubmissions.list({
        courseId: args.courseId,
        courseWorkId: args.courseWorkId ?? "-",
        userId: "me",
        states: args?.estados,
        pageSize: 200,
      });
      const items = (r.data.studentSubmissions ?? []).map(slimSubmission);
      return { total: items.length, entregas: items };
    }

    case "minhas_notas": {
      const [cwRes, subRes, curso] = await Promise.all([
        c.courses.courseWork.list({
          courseId: args.courseId,
          courseWorkStates: ["PUBLISHED"],
          pageSize: 100,
        }),
        c.courses.courseWork.studentSubmissions.list({
          courseId: args.courseId,
          courseWorkId: "-",
          userId: "me",
          pageSize: 200,
        }),
        c.courses.get({ id: args.courseId }),
      ]);

      const porTarefa = new Map<string, any>();
      for (const s of subRes.data.studentSubmissions ?? []) porTarefa.set(s.courseWorkId!, s);

      let obtido = 0;
      let possivel = 0;
      const itens = (cwRes.data.courseWork ?? []).map((w: any) => {
        const s = porTarefa.get(w.id);
        const nota = s?.assignedGrade ?? null;
        if (nota !== null && w.maxPoints) {
          obtido += nota;
          possivel += w.maxPoints;
        }
        return {
          titulo: w.title,
          courseWorkId: w.id,
          nota,
          valor: w.maxPoints ?? null,
          estado: s?.state ?? "SEM_ENTREGA",
          atrasado: s?.late ?? false,
        };
      });

      return {
        turma: curso.data.name,
        itens,
        corrigido: { obtido, possivel, percentual: possivel ? +((obtido / possivel) * 100).toFixed(1) : null },
        aviso: "Considera apenas o que ja foi corrigido. Nao reflete pesos ou formula final da disciplina.",
      };
    }

    case "listar_avisos": {
      const r = await c.courses.announcements.list({
        courseId: args.courseId,
        pageSize: args?.limite ?? 20,
        orderBy: "updateTime desc",
      });
      return {
        total: (r.data.announcements ?? []).length,
        avisos: (r.data.announcements ?? []).map((a: any) => ({
          id: a.id,
          texto: a.text,
          publicadoEm: a.creationTime ? fmt(new Date(a.creationTime)) : null,
          anexos: (a.materials ?? []).length,
          link: a.alternateLink,
        })),
      };
    }

    case "listar_materiais": {
      const r = await c.courses.courseWorkMaterials.list({
        courseId: args.courseId,
        pageSize: args?.limite ?? 30,
      });
      return {
        total: (r.data.courseWorkMaterial ?? []).length,
        materiais: (r.data.courseWorkMaterial ?? []).map((m: any) => ({
          id: m.id,
          titulo: m.title,
          descricao: m.description ?? null,
          topicId: m.topicId ?? null,
          anexos: (m.materials ?? []).map((x: any) =>
            x.driveFile
              ? { tipo: "arquivo", nome: x.driveFile.driveFile?.title, link: x.driveFile.driveFile?.alternateLink }
              : x.link
              ? { tipo: "link", link: x.link.url }
              : { tipo: "outro" }
          ),
          link: m.alternateLink,
        })),
      };
    }

    case "listar_topicos": {
      const r = await c.courses.topics.list({ courseId: args.courseId, pageSize: 100 });
      return {
        topicos: (r.data.topic ?? []).map((t: any) => ({ id: t.topicId, nome: t.name })),
      };
    }

    case "listar_professores": {
      const r = await c.courses.teachers.list({ courseId: args.courseId, pageSize: 30 });
      return {
        professores: (r.data.teachers ?? []).map((t: any) => ({
          nome: t.profile?.name?.fullName,
          email: t.profile?.emailAddress ?? null,
        })),
      };
    }

    case "buscar": {
      const termo = String(args.termo).toLowerCase();
      const cursos = await meusCursos();
      const achados: any[] = [];

      await Promise.all(
        cursos.map(async (curso: any) => {
          const [cw, an, mat] = await Promise.all([
            c.courses.courseWork.list({ courseId: curso.id, pageSize: 100 }).catch(() => null),
            c.courses.announcements.list({ courseId: curso.id, pageSize: 50 }).catch(() => null),
            c.courses.courseWorkMaterials.list({ courseId: curso.id, pageSize: 50 }).catch(() => null),
          ]);

          const bate = (...campos: any[]) =>
            campos.some((x) => typeof x === "string" && x.toLowerCase().includes(termo));

          for (const w of cw?.data.courseWork ?? [])
            if (bate(w.title, w.description))
              achados.push({ tipo: "tarefa", turma: curso.name, courseId: curso.id, id: w.id, titulo: w.title, link: w.alternateLink });

          for (const a of an?.data.announcements ?? [])
            if (bate(a.text))
              achados.push({ tipo: "aviso", turma: curso.name, courseId: curso.id, id: a.id, trecho: String(a.text).slice(0, 200), link: a.alternateLink });

          for (const m of mat?.data.courseWorkMaterial ?? [])
            if (bate(m.title, m.description))
              achados.push({ tipo: "material", turma: curso.name, courseId: curso.id, id: m.id, titulo: m.title, link: m.alternateLink });
        })
      );

      return { termo: args.termo, total: achados.length, resultados: achados };
    }

    case "entregar_tarefa": {
      if (!ENABLE_TURN_IN) throw new Error("Entrega desabilitada neste servidor.");
      const subs = await c.courses.courseWork.studentSubmissions.list({
        courseId: args.courseId,
        courseWorkId: args.courseWorkId,
        userId: "me",
      });
      const sub = (subs.data.studentSubmissions ?? [])[0];
      if (!sub) throw new Error("Nenhuma entrega encontrada para esta tarefa.");
      await c.courses.courseWork.studentSubmissions.turnIn({
        courseId: args.courseId,
        courseWorkId: args.courseWorkId,
        id: sub.id!,
        requestBody: {},
      });
      return { ok: true, mensagem: "Tarefa marcada como entregue.", submissionId: sub.id };
    }

    case "cancelar_entrega": {
      if (!ENABLE_TURN_IN) throw new Error("Entrega desabilitada neste servidor.");
      const subs = await c.courses.courseWork.studentSubmissions.list({
        courseId: args.courseId,
        courseWorkId: args.courseWorkId,
        userId: "me",
      });
      const sub = (subs.data.studentSubmissions ?? [])[0];
      if (!sub) throw new Error("Nenhuma entrega encontrada para esta tarefa.");
      await c.courses.courseWork.studentSubmissions.reclaim({
        courseId: args.courseId,
        courseWorkId: args.courseWorkId,
        id: sub.id!,
        requestBody: {},
      });
      return { ok: true, mensagem: "Entrega cancelada. A tarefa voltou a ser rascunho." };
    }

    default:
      throw new Error(`Tool desconhecida: ${nome}`);
  }
}

function criarServidor(): Server {
  const server = new Server(
    { name: "classroom-aluno-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const resultado = await chamarTool(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(resultado, null, 2) }] };
    } catch (e: any) {
      const detalhe = e?.response?.data?.error?.message || e?.message || String(e);
      return {
        content: [{ type: "text", text: `Erro em ${req.params.name}: ${detalhe}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------- http

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/", (_req, res) => {
  res.json({ servico: "classroom-aluno-mcp", status: "no ar", endpoint: "/mcp/<MCP_SECRET>" });
});

function autorizado(req: express.Request): boolean {
  if (req.params.secret === MCP_SECRET) return true;
  const h = req.headers.authorization;
  return h === `Bearer ${MCP_SECRET}`;
}

app.post("/mcp/:secret", async (req, res) => {
  if (!autorizado(req)) {
    res.status(401).json({ error: "nao autorizado" });
    return;
  }

  // Modo stateless: uma instancia por requisicao. Sobrevive a redeploys
  // e nao guarda sessao no processo.
  const server = criarServidor();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] falha:", e);
    if (!res.headersSent) res.status(500).json({ error: "erro interno" });
  }
});

// Em modo stateless nao ha stream do servidor nem sessao a encerrar.
app.get("/mcp/:secret", (_req, res) => res.status(405).json({ error: "use POST" }));
app.delete("/mcp/:secret", (_req, res) => res.status(405).json({ error: "sem sessao" }));

app.listen(PORT, "0.0.0.0", () => {
  console.error(`classroom-aluno-mcp ouvindo na porta ${PORT}`);
  console.error(`tools expostas: ${TOOLS.length}${ENABLE_TURN_IN ? " (entrega habilitada)" : ""}`);
});
