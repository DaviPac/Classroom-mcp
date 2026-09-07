#!/usr/bin/env node
/**
 * Helper TEMPORARIO de bootstrap OAuth, usado apenas quando nao ha
 * maquina local disponivel para rodar auth.js. Roda em um servico
 * Railway descartavel, captura o code do consentimento via redirect
 * HTTPS publico e imprime o refresh_token APENAS nos logs do servico
 * (nunca na resposta HTTP). Depois de usado, este arquivo e removido
 * do repositorio e o servico volta a rodar dist/index.js.
 */
import http from "http";
import { google } from "googleapis";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = process.env.PORT || 3000;
const ENABLE_TURN_IN = process.env.ENABLE_TURN_IN === "true";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("[fatal] defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET");
  process.exit(1);
}

const ESCOPO_LEITURA = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/classroom.topics.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
];

const escopos =
  ENABLE_TURN_IN === true
    ? [
        ...ESCOPO_LEITURA.filter((s) => !s.includes("coursework.me")),
        "https://www.googleapis.com/auth/classroom.coursework.me",
      ]
    : ESCOPO_LEITURA;

function redirectUriFromReq(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}/oauth2callback`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const redirectUri = redirectUriFromReq(req);
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, redirectUri);

  if (url.pathname === "/") {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: escopos,
    });
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  if (url.pathname === "/oauth2callback") {
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("sem code");
      return;
    }
    try {
      const { tokens } = await oAuth2Client.getToken(code);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>Pronto. Pode fechar esta aba.</h2>");
      console.log("=== REFRESH TOKEN OBTIDO (verifique os logs deste deploy) ===");
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log("===============================================================");
      if (!tokens.refresh_token) {
        console.log("Sem refresh_token. Revogue o acesso em https://myaccount.google.com/permissions e tente de novo.");
      }
    } catch (e) {
      console.error("Falha ao trocar o code:", e.message);
      res.writeHead(500).end("erro");
    }
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`oauth-web-helper ouvindo na porta ${PORT}`);
  console.log("Abra a raiz do dominio publico para iniciar o consentimento.");
});
