/**
 * In-memory session store for remote MCP drawing sessions.
 * Each session holds resolved Excalidraw elements and an optional SVG cache.
 * Sessions expire after 24 hours with lazy checks on access and periodic cleanup.
 */
import crypto from "node:crypto";

/** A single drawing session. */
export interface Session {
  /** Unique session identifier (UUID). */
  sessionKey: string;
  /** Resolved Excalidraw elements array. */
  elements: any[];
  /** Cached SVG string, invalidated when elements change. */
  svgCache: string | null;
  /** When the session was created. */
  createdAt: Date;
  /** When the session expires. */
  expiresAt: Date;
}

/** 24 hours in milliseconds. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Cleanup interval: 10 minutes. */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** Maximum number of concurrent sessions before evicting oldest. */
const MAX_SESSIONS = 100;

/**
 * Manages in-memory drawing sessions with automatic expiry.
 *
 * Follows similar patterns to CheckpointStore: validation, size limits,
 * and lazy eviction of old entries.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Create a new drawing session with 24h TTL.
   *
   * @returns The newly created session.
   */
  createSession(): Session {
    // Evict oldest session if at capacity
    if (this.sessions.size >= MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, session] of this.sessions) {
        if (session.createdAt.getTime() < oldestTime) {
          oldestTime = session.createdAt.getTime();
          oldestKey = key;
        }
      }
      if (oldestKey) this.sessions.delete(oldestKey);
    }

    const sessionKey = crypto.randomUUID();
    const now = new Date();
    const session: Session = {
      sessionKey,
      elements: [],
      svgCache: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    };
    this.sessions.set(sessionKey, session);
    return session;
  }

  /**
   * Retrieve a session by key. Returns null if not found or expired.
   *
   * @param key - Session UUID.
   * @returns The session, or null if not found/expired.
   */
  getSession(key: string): Session | null {
    const session = this.sessions.get(key);
    if (!session) return null;
    if (new Date() > session.expiresAt) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  /**
   * Update the elements for a session. Invalidates SVG cache.
   *
   * @param key - Session UUID.
   * @param elements - New resolved elements array.
   * @returns True if the session was found and updated.
   */
  updateElements(key: string, elements: any[]): boolean {
    const session = this.getSession(key);
    if (!session) return false;
    session.elements = elements;
    session.svgCache = null;
    return true;
  }

  /**
   * Cache rendered SVG for a session.
   *
   * @param key - Session UUID.
   * @param svg - SVG string to cache.
   * @returns True if the session was found and updated.
   */
  updateSvgCache(key: string, svg: string): boolean {
    const session = this.getSession(key);
    if (!session) return false;
    session.svgCache = svg;
    return true;
  }

  /** Remove all expired sessions. Called periodically by setInterval. */
  private cleanup(): void {
    const now = new Date();
    for (const [key, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(key);
      }
    }
  }

  /** Stop the cleanup timer. Call on shutdown. */
  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}
