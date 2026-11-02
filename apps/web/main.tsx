import React from "react";
import { createRoot } from "react-dom/client";
import { CloudApp } from "../../packages/task-ui/app.tsx";
import { browserTransport } from "../../packages/task-ui/transport.ts";
const transport = browserTransport();
createRoot(document.getElementById("root")!).render(
  <CloudApp transport={transport} />,
);
