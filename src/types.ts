// Removed whatsapp-web.js imports - now using WPPConnect
import { Collection } from 'lokijs';

// Environment variables interface
export interface Environment {
  NODE_ENV?: string | undefined;
  M_WAITING_TIME?: string | undefined;
  CHROMIUM_PATH?: string | undefined;
  WHITELISTED_NUMBERS?: string | undefined;
  ALLOWED_NUMBERS?: string | undefined;
  FW_ENDPOINT?: string | undefined;
  FW_ENDPOINT_WORKFLOW?: string | undefined;
  FW_AUTH_TOKEN?: string | undefined;
  JWT_SECRET?: string | undefined;
  WA_JWT_SECRET?: string | undefined;
  AI_AGENT?: string | undefined;
  PORT?: string | undefined;
  MONGODB_URI?: string | undefined;
  UPLOAD_USER_ID?: string | undefined;
  UPLOAD_AUTH_TOKEN?: string | undefined;
  AUTO_RESTART_CRON?: string | undefined;
  AUTO_RESTART_METHOD?: string | undefined;
  AI_REQUEST_TIMEOUT?: string | undefined;
  VAULT_ADDR?: string | undefined;
  VAULT_TOKEN?: string | undefined;
  VAULT_KEY_NAME?: string | undefined;
}

// WhatsApp Service Configuration interface
export interface WhatsAppServiceConfig {
  chromiumPath: string;
  puppeteerArgs: string[];
  mongoUri: string;
  backupSyncIntervalMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  healthCheckIntervalMs?: number;
}

// AI Agent response interface
export interface AIAgentResponse {
  text: string;
  session: string | null;
}

// Configuration interfaces
export interface FWConfig {
  question: string;
  overrideConfig: {
    sessionId?: string;
  };
}

// Database interfaces
export interface NumberEntry {
  number: string;
  campaign?: string | undefined;
  session?: string | undefined;
}

export interface Database {
  getCollection: (name: string) => Collection<NumberEntry> | null;
  addCollection: (name: string) => Collection<NumberEntry>;
  loadDatabase: (options: any, callback: () => void) => void;
}

// Message queue interfaces
export interface QueuedMessage {
  message: any; // WPPConnect message object
  timestamp: number;
}

export interface MessageQueue {
  [key: string]: QueuedMessage[];
}

// Processing state interface
export interface ProcessingState {
  [key: string]: number; // user -> timestamp
}

// Chat message interface for conversation context
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Workflow response message object types
export interface WorkflowMessageObject {
  type: 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'animated-sticker' | 'reaction' | 'location' | 'reply' | 'stop-response' | 'block' | 'pause';
  text?: string;
  url?: string;
  caption?: string;
  latitude?: number;
  longitude?: number;
  messageid?: string;
  emoji?: string;
  reason?: string;
  from?: string;
  to?: string;
}

// Workflow API response interface
export interface WorkflowResponse {
  status: string;
  steps: any;
  result: {
    success: boolean;
    content: {
      text?: string;
      object: WorkflowMessageObject[];
    };
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
    };
    formatted?: {
      whatsapp?: WorkflowMessageObject[];
    };
    timestamp?: string;
  };
}

// API request interfaces
export interface GreetingRequest {
  sender: string;
  message: string;
  campaign: string;
}

export interface GreetingResponse {
  success: boolean;
  message: string;
}

export interface ErrorResponse {
  error: string;
}

// WhatsApp client interfaces
export interface WhatsAppClient {
  info?: {
    wid: {
      _serialized: string;
    };
  };
  initialize: () => void;
  sendMessage: (chatId: string, content: string) => Promise<any>;
  on: (event: string, callback: (...args: any[]) => void) => void;
}

// Express app interface
export interface ExpressApp {
  use: (middleware: any) => void;
  post: (path: string, handler: (req: any, res: any) => void) => void;
  get: (path: string, handler: (req: any, res: any) => void) => void;
  delete: (path: string, handler: (req: any, res: any) => void) => void;
  listen: (port: number, callback: () => void) => void;
} 