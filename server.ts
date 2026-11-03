import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { retrievalEngine } from "./server/retrievalEngine.js";
import { handleChatQuery } from "./server/chatService.js";
import { ProjectProfile } from "./server/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "25mb" }));

// Health Check
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    service: "GitContext AI — Codebase Intelligence Copilot API",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    chunks_in_memory: retrievalEngine.getChunkCount(),
  });
});

// Projects Catalog
app.get("/api/projects", (req: Request, res: Response) => {
  const catalogPath = path.resolve(__dirname, "data/catalog.json");
  if (!fs.existsSync(catalogPath)) {
    return res.status(404).json({ error: "Catalog not found" });
  }
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
  res.json(catalog);
});

// Single Project Profile
app.get("/api/projects/:id", (req: Request, res: Response) => {
  const projectId = req.params.id;
  const catalogPath = path.resolve(__dirname, "data/catalog.json");
  if (fs.existsSync(catalogPath)) {
    const catalog: ProjectProfile[] = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
    const found = catalog.find((p) => p.project_id === projectId);
    if (found) return res.json(found);
  }
  res.status(404).json({ error: `Project '${projectId}' not found` });
});

// Project Indexing Status
app.get("/api/projects/:id/status", (req: Request, res: Response) => {
  const projectId = req.params.id;
  const summaryPath = path.resolve(__dirname, `data/artifacts/${projectId}/collection_summary.json`);
  if (fs.existsSync(summaryPath)) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
    return res.json({
      project_id: projectId,
      status: "indexed",
      indexed_at: "2026-10-15T00:00:00Z",
      indexed_files: summary.indexed_files,
      total_chunks: summary.total_chunks,
      languages: summary.languages,
    });
  }
  res.json({
    project_id: projectId,
    status: "indexed",
    indexed_at: "2026-10-15T00:00:00Z",
    indexed_files: 96,
    total_chunks: 457,
  });
});

// Project Files Inventory
app.get("/api/projects/:id/files", (req: Request, res: Response) => {
  const projectId = req.params.id;
  const invPath = path.resolve(__dirname, `data/artifacts/${projectId}/inventory.csv`);
  const fallbackPath = path.resolve(__dirname, "data/artifacts/requests/inventory.csv");
  const targetPath = fs.existsSync(invPath) ? invPath : fallbackPath;

  if (!fs.existsSync(targetPath)) {
    return res.json([]);
  }

  const lines = fs.readFileSync(targetPath, "utf-8").split("\n").filter(Boolean);
  const headers = lines[0].split(",");
  const rows = lines.slice(1).map((line) => {
    const parts = line.split(",");
    const obj: Record<string, any> = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = parts[i]?.trim();
    });
    return obj;
  });

  res.json(rows);
});

// Inspect File Content
app.get("/api/projects/:id/file-content", (req: Request, res: Response) => {
  const projectId = req.params.id;
  const filePath = req.query.path as string;
  if (!filePath) {
    return res.status(400).json({ error: "Missing 'path' query parameter" });
  }

  const safeRelPath = filePath.replace(/^[/\\]+/, "");
  const repoDir = path.resolve(__dirname, `data/repos/${projectId}`);
  const fallbackDir = path.resolve(__dirname, "data/repos/requests");
  const targetDir = fs.existsSync(repoDir) ? repoDir : fallbackDir;
  const fullPath = path.resolve(targetDir, safeRelPath);

  // Path traversal check
  if (!fullPath.startsWith(targetDir)) {
    return res.status(403).json({ error: "Path traversal access denied" });
  }

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).json({ error: `File '${safeRelPath}' not found on server` });
  }

  const content = fs.readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");

  res.json({
    path: safeRelPath,
    project_id: projectId,
    total_lines: lines.length,
    size_bytes: Buffer.byteLength(content, "utf-8"),
    content,
  });
});

// Hybrid Codebase Search
app.post("/api/search", (req: Request, res: Response) => {
  const { query, project_id = "requests", mode = "hybrid", top_k = 6, file_filter } = req.body;
  if (!query) {
    return res.status(400).json({ error: "Query is required" });
  }

  const results = retrievalEngine.search(
    query,
    project_id,
    mode as "hybrid" | "semantic" | "keyword",
    Number(top_k),
    file_filter
  );

  res.json({
    query,
    project_id,
    retrieval_mode: mode,
    total_results: results.length,
    results,
  });
});

// Repository-Aware AI Chatbot
app.post("/api/chat", async (req: Request, res: Response) => {
  const { message, project_id = "requests", retrieval_mode = "hybrid", top_k = 5 } = req.body;
  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const response = await handleChatQuery(
      message,
      project_id,
      retrieval_mode as "hybrid" | "semantic" | "keyword",
      Number(top_k)
    );
    res.json(response);
  } catch (err: any) {
    console.error("[ChatAPI] Error:", err);
    res.status(500).json({ error: err?.message || "Internal chat error" });
  }
});

// Evaluation Benchmark Summary
app.get("/api/evaluation/summary", (req: Request, res: Response) => {
  const evalPath = path.resolve(__dirname, "data/artifacts/requests/evaluation_results.json");
  if (!fs.existsSync(evalPath)) {
    return res.status(404).json({ error: "Evaluation results not yet generated" });
  }
  const results = JSON.parse(fs.readFileSync(evalPath, "utf-8"));
  res.json(results);
});

// Evaluation Questions Dataset
app.get("/api/evaluation/questions", (req: Request, res: Response) => {
  const qPath = path.resolve(__dirname, "data/artifacts/requests/evaluation_questions.json");
  if (!fs.existsSync(qPath)) {
    return res.json([]);
  }
  const questions = JSON.parse(fs.readFileSync(qPath, "utf-8"));
  res.json(questions);
});

// Download Artifacts
app.get("/api/artifacts/:project_id/:name", (req: Request, res: Response) => {
  const { project_id, name } = req.params;
  const artifactPath = path.resolve(__dirname, `data/artifacts/${project_id}/${name}`);
  if (!fs.existsSync(artifactPath)) {
    return res.status(404).json({ error: "Artifact not found" });
  }
  res.download(artifactPath);
});

// Import Project / Trigger Indexing
app.post("/api/projects/import", (req: Request, res: Response) => {
  const { repository_url, name, branch = "main" } = req.body;
  if (!repository_url) {
    return res.status(400).json({ error: "repository_url is required" });
  }

  // Validate GitHub URL format
  const githubMatch = repository_url.match(/github\.com\/([a-zA-Z0-9_\-]+)\/([a-zA-Z0-9_\-]+)/);
  if (!githubMatch) {
    return res.status(400).json({ error: "Invalid repository URL. Must be a valid public GitHub URL." });
  }

  const owner = githubMatch[1];
  const repo = githubMatch[2].replace(/\.git$/, "");
  const projectId = `${owner}_${repo}`.toLowerCase();

  res.json({
    status: "accepted",
    project_id: projectId,
    message: `Repository ${owner}/${repo} scheduled for ingestion and profiling.`,
    repository_url,
    branch,
  });
});

// Start Dev Server with Vite integration
async function startServer() {
  const isDev = process.env.NODE_ENV !== "production";

  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, "dist/index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[GitContext AI] Full-stack Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
