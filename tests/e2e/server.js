// テスト対象のフィクスチャページを配信するだけの、依存ゼロの簡易静的サーバー。
// content_scripts は http(s) URLに対してのみ確実に動作を保証するため、
// file:// ではなくこのサーバー経由でフィクスチャページを開く。
const http = require("http");
const fs = require("fs");
const path = require("path");

const FIXTURES_DIR = path.join(__dirname, "fixtures");

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const filePath = path.join(FIXTURES_DIR, "page.html");
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end("failed to load fixture");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

module.exports = { startFixtureServer };
