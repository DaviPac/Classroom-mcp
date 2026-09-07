#!/usr/bin/env node
/**
 * Rode UMA VEZ na sua maquina: node auth.js
 * Abre o consentimento do Google e imprime o GOOGLE_REFRESH_TOKEN
 * que voce vai colar nas variaveis do Railway.
 */
import http from "http";
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 3000;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env antes de rodar.");
  process.exit(1);
}

// Escopos de ALUNO. Leitura, exceto coursework.me quando a entrega esta ligada.
const ESCOPO_LEITURA = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/classroom.topics.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
];

// Se voce quer poder ENTREGAR tarefas pelo MCP, rode: ENABLE_TURN_IN=true node auth.js
const escopos =
  process.env.ENABLE_TURN_IN === "true"
    ? [
        ...ESCOPO_LEITURA.filter((s) => !s.includes("coursework.me")),
        "https://www.googleapis.com/auth/classroom.coursework.me",
      ]
    : ESCOPO_LEITURA;

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);

const url = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: escopos,
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("sem code");
    return;
  }
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>Pronto. Volte ao terminal.</h2>");
    console.log("\n=========================================================");
    console.log("Cole isto nas variaveis de ambiente do Railway:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("=========================================================\n");
    if (!tokens.refresh_token) {
      console.log("Sem refresh_token. Revogue o acesso em");
      console.log("https://myaccount.google.com/permissions e rode de novo.\n");
    }
  } catch (e) {
    console.error("Falha ao trocar o code:", e.message);
    res.writeHead(500).end("erro");
  }
  server.close();
  setTimeout(() => process.exit(0), 300);
});

server.listen(PORT, () => {
  console.log("\nEscopos solicitados:");
  escopos.forEach((s) => console.log("  - " + s.split("/auth/")[1]));
  console.log("\nAbra esta URL no navegador:\n");
  console.log(url + "\n");
});
