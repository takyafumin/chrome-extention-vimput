// テスト用の最小限の静的ファイルサーバー。
// Chrome拡張機能のコンテンツスクリプトはfile://ページには既定でアクセスできない
// ため、受け入れテストではhttp://経由でフィクスチャページを配信する。
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "fixtures");
const PORT = Number(process.env.E2E_FIXTURE_PORT) || 4173;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function requestListener(req, res) {
  const urlPath = req.url === "/" ? "/page.html" : req.url.split("?")[0];
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT, safePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

if (require.main === module) {
  const server = http.createServer(requestListener);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[e2e fixture server] listening on http://127.0.0.1:${PORT}`);
  });
}

module.exports = { requestListener, PORT };
