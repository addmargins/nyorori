// Minimal node:http webhook adapter: verifies X-Hub-Signature-256 over the raw
// body before parsing anything, then hands the event to the dispatcher.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** GitHub caps webhook payloads at 25 MB. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function signatureFor(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(signatureFor(secret, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface WebhookOptions {
  secret: string;
  dispatch: (event: string, payload: unknown, deliveryId: string) => Promise<unknown>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Remembered delivery ids, to drop GitHub redeliveries of the same event. */
  dedupeSize?: number;
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Returns a request handler. The returned promise resolves after dispatch
 * finishes so tests can await processing; the HTTP response is sent first.
 */
export function createWebhookHandler(opts: WebhookOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const seen: string[] = [];
  const limit = opts.dedupeSize ?? 1000;
  return async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      res.writeHead(413).end();
      return;
    }
    const sig = req.headers["x-hub-signature-256"];
    if (!verifySignature(opts.secret, body, Array.isArray(sig) ? sig[0] : sig)) {
      res.writeHead(401).end();
      return;
    }
    const event = String(req.headers["x-github-event"] ?? "");
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (delivery && seen.includes(delivery)) {
      res.writeHead(200).end("duplicate");
      return;
    }
    if (delivery) {
      seen.push(delivery);
      if (seen.length > limit) seen.shift();
    }
    res.writeHead(202).end();
    try {
      await opts.dispatch(event, payload, delivery);
    } catch (e) {
      opts.log?.("dispatch failed", { event, delivery, error: String(e) });
    }
  };
}

export function createWebhookServer(opts: WebhookOptions): Server {
  const handler = createWebhookHandler(opts);
  return createServer((req, res) => {
    void handler(req, res);
  });
}
