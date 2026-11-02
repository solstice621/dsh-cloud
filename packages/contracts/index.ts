import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

export const PROTOCOL = 1;
export const DSH_VERSION = "0.2.2-alpha.2";
export const DSH_SHA = "ce7073d51254c26cd63b22a60835b8f948deb447";
export const terminalStates = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "uncertain",
] as const;
export type RunState =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_input"
  | "finalizing"
  | "cancelling"
  | (typeof terminalStates)[number];
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export const id = () => randomUUID();
export const secret = () => randomBytes(32).toString("base64url");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : canonical(value))
    .digest("hex");
export const equalSecret = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
export class CloudError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue(
  condition: unknown,
  code: string,
  message: string,
  status = 409,
): asserts condition {
  if (!condition) throw new CloudError(status, code, message);
}
export const TemplateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    version: z.string().min(1).max(64),
    image: z.string().min(1).max(300),
    platforms: z.array(z.enum(["linux/amd64", "linux/arm64"])).min(1),
    setup: z.array(z.string().max(10000)).default([]),
    start: z.array(z.string().max(10000)).default([]),
    checks: z
      .array(
        z
          .object({
            name: z.string().max(100),
            command: z.string().max(10000),
            required: z.boolean().default(true),
          })
          .strict(),
      )
      .default([]),
    minFreeDiskMb: z.number().int().min(128).default(2048),
    cpu: z.number().positive().max(64).default(2),
    memoryMb: z.number().int().min(256).max(131072).default(4096),
    timeoutSeconds: z.number().int().min(10).max(86400).default(3600),
    maxModelCalls: z.number().int().min(1).max(10000).default(100),
    maxOutputTokens: z.number().int().min(128).max(131072).default(8192),
    proxy: z
      .object({
        http: z
          .string()
          .url()
          .refine(
            (v) =>
              ["http:", "https:"].includes(new URL(v).protocol) &&
              !new URL(v).username &&
              !new URL(v).password,
            "Use a proxy URL without credentials",
          )
          .optional(),
        https: z
          .string()
          .url()
          .refine(
            (v) =>
              ["http:", "https:"].includes(new URL(v).protocol) &&
              !new URL(v).username &&
              !new URL(v).password,
            "Use a proxy URL without credentials",
          )
          .optional(),
        noProxy: z
          .string()
          .max(4000)
          .default("localhost,127.0.0.1,host.docker.internal"),
      })
      .strict()
      .optional(),
    network: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .default("bridge"),
  })
  .strict();
export type Template = z.infer<typeof TemplateSchema>;
export const TaskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    sessionId: z.string().uuid().optional(),
    requestId: z.string().uuid().optional(),
    runnerId: z.string().uuid(),
    templateId: z.string(),
    templateVersion: z.string(),
    repo: z.string().min(1).max(2048),
    ref: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (v) => !v.startsWith("-") && !/[\s~^:?*\[\\]/.test(v),
        "Invalid Git ref",
      ),
    baseBranch: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (v) =>
          !v.startsWith("-") && !v.includes("..") && !/[\s~^:?*\[\\]/.test(v),
        "Invalid base branch",
      )
      .default("main"),
    input: z.string().trim().min(1).max(100000),
    deliveryPolicy: z.enum(["results", "draft-pr"]).default("results"),
  })
  .strict();
export type TaskInput = z.infer<typeof TaskInputSchema>;
export interface Task {
  id: string;
  ownerId: string;
  title: string;
  runnerId: string;
  sessionId: string;
  environmentId: string;
  templateId: string;
  templateVersion: string;
  repo: string;
  ref: string;
  baseBranch: string;
  baseCommit: string | null;
  branch: string;
  deliveryPolicy: "results" | "draft-pr";
  lifecycle: string;
  environmentState: string;
  epoch: number;
  incarnation: string | null;
  currentRunId: string | null;
  paused: number;
  durableSeq: number;
  workspaceRevision: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}
export interface Run {
  id: string;
  taskId: string;
  ordinal: number;
  input: string;
  kind: string;
  previousRunId: string | null;
  state: RunState;
  commandId: string;
  attemptId: string | null;
  messageId: string | null;
  result: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}
export interface CloudEvent {
  taskId: string;
  taskSeq: number;
  kind: string;
  runId: string | null;
  payload: unknown;
  createdAt: number;
}
export interface ExecutionCommand {
  id: string;
  kind: "execute" | "cancel";
  taskId: string;
  runId: string;
  attemptId: string;
  epoch: number;
  input?: string;
}
export interface ExecutorConfig {
  controlUrl: string;
  token: string;
  task: Task;
  template: Template;
  epoch: number;
  incarnation: string;
  workspace: string;
  dshHome: string;
  stateDir: string;
  model: string;
  modelBaseUrl: string;
  patchPath: string;
  socketPath?: string;
}
export function redact(message: unknown): string {
  return String(message instanceof Error ? message.message : message)
    .replace(
      /(Bearer\s+|api[_-]?key[=: ]+|token[=: ]+)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 4000);
}
