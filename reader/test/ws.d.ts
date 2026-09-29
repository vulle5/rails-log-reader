/**
 * The part of Bun's built-in `ws` the spawned Reader's tests use to open `/repl`: the global
 * `WebSocket` is happy-dom's, which cannot send an `Origin`.
 */
declare module "ws" {
  export class WebSocket {
    constructor(url: string, options: { headers: Record<string, string> })
    on(event: "open", listener: () => void): this
    on(event: "message", listener: (data: Buffer) => void): this
    on(event: "error", listener: (error: Error) => void): this
    send(data: string): void
    close(): void
  }
}
