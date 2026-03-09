/**
 * Simulates the OMP ExtensionAPI for testing.
 *
 * Usage:
 *   const pi = makeMockPi();
 *   registerSomeHandler(pi);
 *   const result = await pi.fire("tool_call", event, ctx);
 *   expect(pi.sentMessages).toContainEqual(...)
 */

import { vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../src/types.js";

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface MockExtensionContext extends Partial<ExtensionContext> {
  cwd: string;
}

/** Default minimal context for tests that don't care about ctx details. */
export function makeCtx(overrides: Partial<MockExtensionContext> = {}): ExtensionContext {
  return {
    cwd: "/test/project",
    isIdle: () => true,
    hasUI: false,
    abort: vi.fn(),
    hasPendingMessages: () => false,
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue(undefined),
    fork: vi.fn().mockResolvedValue(undefined),
    navigateTree: vi.fn().mockResolvedValue(undefined),
    ui: {
      confirm: vi.fn().mockResolvedValue(true),
      notify: vi.fn(),
      select: vi.fn().mockResolvedValue(null),
      input: vi.fn().mockResolvedValue(""),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setEditorComponent: vi.fn(),
      setTitle: vi.fn(),
    },
    sessionManager: {
      getSessionFile: vi.fn().mockReturnValue("/test/.omp/session.json"),
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

export interface MockPi extends ExtensionAPI {
  /** All messages sent via sendMessage(), in order. */
  sentMessages: Array<{ text: string; options: unknown }>;
  /** Map of event name → registered handlers (may be multiple per event). */
  _handlers: Map<string, AnyHandler[]>;
  /**
   * Fire an event, calling all registered handlers in registration order.
   * Returns the last non-undefined result.
   */
  fire(
    event: string,
    eventData?: unknown,
    ctx?: Partial<MockExtensionContext>,
  ): Promise<unknown>;
}

export function makeMockPi(): MockPi {
  const handlers = new Map<string, AnyHandler[]>();
  const sentMessages: Array<{ text: string; options: unknown }> = [];

  const pi: MockPi = {
    sentMessages,
    _handlers: handlers,

    on(event: string, handler: AnyHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },

    sendMessage(text: string, options?: unknown) {
      sentMessages.push({ text, options: options ?? {} });
    },

    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),

    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },

    async fire(
      event: string,
      eventData: unknown = {},
      ctxOverrides: Partial<MockExtensionContext> = {},
    ): Promise<unknown> {
      const ctx = makeCtx(ctxOverrides);
      const list = handlers.get(event) ?? [];
      let last: unknown;
      for (const h of list) {
        const result = await h(eventData, ctx);
        if (result !== undefined) last = result;
      }
      return last;
    },
  } as unknown as MockPi;

  return pi;
}
