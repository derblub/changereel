/** A static file server for the two sample sites of the tests. */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function serve(root, port = 0) {
  const server = createServer((request, response) => {
    const path = request.url.split("?")[0];
    let file = join(root, path === "/" ? "index.html" : path);
    // "/cart" is cart.html, as most servers of static sites have it
    if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!existsSync(file)) return response.writeHead(404).end("Not found");
    response.writeHead(200, { "Content-Type": file.endsWith(".xml") ? "application/xml" : "text/html" });
    response.end(readFileSync(file));
  });
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// node serve.mjs <directory> <port>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serve(process.argv[2], Number(process.argv[3]));
}
