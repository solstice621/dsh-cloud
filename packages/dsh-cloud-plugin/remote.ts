import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol/remote-info";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
const stringCodec = {
  mode: "strict" as const,
  typeSymbol: "dsh-cloud-plugin#JsonEnvelope",
  create: () => z.string(),
  jsonSchema: { type: "string" },
};
/** Explicit wire schema for the single Host-owned API boundary. */
export const remote = createTypertRemoteInfo(
  {
    package: "dsh-cloud-plugin",
    methods: {
      "cloud/invoke": {
        service: "cloud",
        invocation: { kind: "direct" },
        parameters: [
          {
            name: "payload",
            source: "json",
            codec: stringCodec,
            strictCodec: stringCodec,
          },
        ],
        result: stringCodec,
      },
    },
  },
  z,
);
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    cloud: { invoke(payload: string): Promise<RemoteResult<string>> };
  }
}
