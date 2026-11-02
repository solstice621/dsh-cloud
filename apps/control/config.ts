import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  TemplateSchema,
  type Template,
  requireValue,
} from "../../packages/contracts/index.ts";

export interface ControlConfig {
  host: string;
  port: number;
  publicUrl: string;
  database: string;
  webRoot: string;
  artifactRoot?: string;
  ownerId: string;
  development: boolean;
  devToken?: string;
  oidc?: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    ownerSubject: string;
  };
  model: { baseUrl: string; apiKey: string; name: string };
  templates: Template[];
  allowedRepoHosts: string[];
}
export function configFromEnv(env = process.env): ControlConfig {
  const development = env.CLOUD_DEVELOPMENT === "1",
    publicUrl = env.CLOUD_PUBLIC_URL ?? "http://127.0.0.1:8787";
  const url = new URL(publicUrl);
  requireValue(
    url.protocol === "https:" ||
      (development &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
    "TLS_REQUIRED",
    "Production requires an HTTPS public URL",
    400,
  );
  const oidc = env.CLOUD_OIDC_ISSUER
    ? {
        issuer: env.CLOUD_OIDC_ISSUER,
        clientId: env.CLOUD_OIDC_CLIENT_ID ?? "",
        clientSecret: env.CLOUD_OIDC_CLIENT_SECRET ?? "",
        ownerSubject: env.CLOUD_OWNER_SUBJECT ?? "",
      }
    : undefined;
  requireValue(
    development
      ? (env.CLOUD_DEV_TOKEN?.length ?? 0) >= 32
      : !!(oidc?.clientId && oidc.ownerSubject),
    "AUTH_CONFIG",
    "Configure OIDC and owner subject, or explicitly enable development with a 32+ character token",
    400,
  );
  const templates = z
    .array(TemplateSchema)
    .min(1)
    .parse(
      JSON.parse(
        readFileSync(
          resolve(env.CLOUD_TEMPLATES ?? "deploy/templates.json"),
          "utf8",
        ),
      ),
    );
  return {
    host: env.CLOUD_HOST ?? "127.0.0.1",
    port: Number(env.CLOUD_PORT ?? 8787),
    publicUrl: url.origin,
    database: resolve(env.CLOUD_DATABASE ?? ".state/control.sqlite"),
    webRoot: resolve(env.CLOUD_WEB_ROOT ?? "dist/web"),
    ownerId: "owner",
    development,
    devToken: env.CLOUD_DEV_TOKEN,
    oidc,
    artifactRoot: env.CLOUD_ARTIFACT_ROOT,
    model: {
      baseUrl: env.CLOUD_MODEL_BASE_URL ?? "https://api.deepseek.com/anthropic",
      apiKey: env.CLOUD_MODEL_API_KEY ?? "",
      name: env.CLOUD_MODEL_NAME ?? "deepseek-flash",
    },
    templates,
    allowedRepoHosts: (env.CLOUD_GIT_HOSTS ?? "github.com")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
export function validateRepo(repo: string, config: ControlConfig) {
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    throw new Error("Use an HTTPS repository URL");
  }
  requireValue(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "INVALID_REPOSITORY",
    "Repository must be an HTTPS URL without credentials or query parameters",
    400,
  );
  requireValue(
    config.allowedRepoHosts.includes(url.host),
    "REPOSITORY_HOST_DENIED",
    "Repository host is not configured on this service",
    400,
  );
  requireValue(
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname),
    "INVALID_REPOSITORY",
    "Expected an owner/repository URL",
    400,
  );
}
