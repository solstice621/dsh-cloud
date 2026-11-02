import { Transform, type TransformCallback } from "node:stream";
/** Observes upstream usage while passing bytes through unchanged. Missing usage stays unknown. */
export class UsageMeter extends Transform {
  input: number | null = null;
  output: number | null = null;
  complete = false;
  private text = "";
  private decoder = new TextDecoder();
  constructor(private streaming: boolean) {
    super();
  }
  private record(value: any) {
    if (value.type === "message_stop") this.complete = true;
    const usage = value.message?.usage ?? value.usage;
    if (!usage) return;
    for (const [field, key] of [
      ["input", "input_tokens"],
      ["output", "output_tokens"],
    ] as const) {
      const n = usage[key];
      if (Number.isSafeInteger(n) && n >= 0)
        this[field] = Math.max(this[field] ?? 0, n);
    }
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    this.push(chunk);
    this.text += this.decoder.decode(chunk, { stream: true });
    if (this.streaming) {
      let end: number;
      while ((end = this.text.indexOf("\n")) >= 0) {
        const line = this.text.slice(0, end);
        this.text = this.text.slice(end + 1);
        if (line.startsWith("data:"))
          try {
            this.record(JSON.parse(line.slice(5).trim()));
          } catch {}
      }
    }
    if (this.text.length > 16 * 1024 * 1024) this.text = "";
    callback();
  }
  override _flush(callback: TransformCallback) {
    if (!this.streaming)
      try {
        this.record(JSON.parse(this.text + this.decoder.decode()));
        this.complete = true;
      } catch {}
    callback();
  }
}
