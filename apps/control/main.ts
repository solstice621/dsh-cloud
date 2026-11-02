import { configFromEnv } from "./config.ts";
import { ControlService } from "./server.ts";
const service = new ControlService(configFromEnv());
await service.listen();
console.log(`DSH Cloud control listening at ${service.config.publicUrl}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (!stopping) {
      stopping = true;
      void service.close().then(() => process.exit(0));
    }
  });
