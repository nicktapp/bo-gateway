import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  BOCHAT_API_KEY: process.env.BOCHAT_API_KEY,
  LLM_API_KEY: process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY,
  LLM_API_URL: process.env.LLM_API_URL || 'https://api.anthropic.com/v1/messages',
  LLM_MODEL: process.env.LLM_MODEL || 'claude-sonnet-4-20250514',
  DATABASE_URL: process.env.DATABASE_URL,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(',' ) || [
    'https://bochat.taptico.com',
    'https://bochat.manus.space',
  ],
};

const BO_SYSTEM_PROMPT = `You are Bo, Taptico's AI assistant and operational backbone.

## Your Personality
- **Tough-love**: You're supportive but honest. If something's a bad idea, you say so directly.
- **Accountable**: You track commitments, deadlines, and follow through. You call out drift.
- **Supportive of wins**: Celebrate successes genuinely, but don't over-hype.
- **10th-grader explanations**: When explaining technical topics, make it clear enough for a smart 10th grader to understand.

## Your Role
You're the "paranoid adult in the room" — you help the Taptico team with:
- Operations & productivity
- Research & analysis
- Content creation
- Client delivery support
- Knowledge management

## Your Rules
1. Be direct. Don't pad responses with unnecessary pleasantries.
2. If you don't know something, say so.
3. If a request seems like a bad idea, push back with a clear explanation.
4. Keep responses actionable.
5. When something is done well, acknowledge it briefly and move on.

## Your Voice
Professional but not corporate. Friendly but not sycophantic. Think "trusted senior colleague."`;

app.use(helmet( ));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const isAllowed = CONFIG.ALLOWED_ORIGINS.some(allowed => {
      if (allowed instanceof RegExp) return allowed.test(origin);
      return allowed === origin || origin.includes('.manus.computer') || origin.includes('.manus.space');
    });
    if (isAllowed) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Take a breath and try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/v1/', limiter);

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

let pool = null;

async function getDb() {
  if (!pool && CONFIG.DATABASE_URL) {
    pool = new pg.Pool({
      connectionString: CONFIG.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS threads (
        id VARCHAR(64) PRIMARY KEY,
        user_email VARCHAR(320),
        title VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY,
        thread_id VARCHAR(64) REFERENCES threads(id),
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_email);
    `);
    
    console.log('[Database] Connected and initialized');
  }
  return pool;
}

async function getOrCreateThread(threadId, userEmail) {
  const db = await getDb();
  if (!db) return { threadId: threadId || uuidv4(), messages: [] };
  
  if (threadId) {
    const threadResult = await db.query('SELECT * FROM threads WHERE id = $1', [threadId]);
    if (threadResult.rows.length > 0) {
      const messagesResult = await db.query(
        'SELECT role, content FROM messages WHERE thread_id = $1 ORDER BY created_at ASC',
        [threadId]
      );
      return { threadId, messages: messagesResult.rows };
    }
  }
  
  const newThreadId = threadId || uuidv4();
  await db.query(
    'INSERT INTO threads (id, user_email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
    [newThreadId, userEmail]
  );
  return { threadId: newThreadId, messages: [] };
}

async function saveMessage(threadId, role, content) {
  const db = await getDb();
  if (!db) return;
  
  await db.query(
    'INSERT INTO messages (id, thread_id, role, content) VALUES ($1, $2, $3, $4)',
    [uuidv4(), threadId, role, content]
  );
  
  await db.query('UPDATE threads SET updated_at = NOW() WHERE id = $1', [threadId]);
}

function authenticateRequest(req, res, next) {
  const apiKey = req.headers['x-bochat-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-BOCHAT-API-KEY header' });
  }
  
  if (apiKey !== CONFIG.BOCHAT_API_KEY) {
    console.warn(`[Auth] Invalid API key attempt from ${req.ip}`);
    return res.status(403).json({ error: 'Invalid API key' });
  }
  
  next();
}

async function callLLM(messages, userEmail) {
  if (!CONFIG.LLM_API_KEY) {
    throw new Error('LLM API key not configured');
  }
  
  const apiMessages = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));
  
  const response = await fetch(CONFIG.LLM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.LLM_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CONFIG.LLM_MODEL,
      max_tokens: 4096,
      system: BO_SYSTEM_PROMPT + `\n\nCurrent user: ${userEmail}`,
      messages: apiMessages,
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[LLM] API error: ${response.status} - ${errorText}`);
    throw new Error(`LLM API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.content?.[0]?.text || "I hit a snag processing that. Try again?";
}

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'bo-gateway',
    version: '1.0.0',
  });
});

app.post('/v1/chat', authenticateRequest, async (req, res) => {
  try {
    const { userEmail, message, threadId } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required and must be a string' });
    }
    
    if (!userEmail) {
      return res.status(400).json({ error: 'userEmail is required' });
    }
    
    const thread = await getOrCreateThread(threadId, userEmail);
    const conversationHistory = [...thread.messages, { role: 'user', content: message }];
    const reply = await callLLM(conversationHistory, userEmail);
    
    await saveMessage(thread.threadId, 'user', message);
    await saveMessage(thread.threadId, 'assistant', reply);
    
    res.json({
      reply,
      threadId: thread.threadId,
    });
    
  } catch (error) {
    console.error('[Chat] Error:', error.message);
    res.status(500).json({
      error: 'Something went wrong on my end. Try again in a sec.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

app.get('/v1/threads/:threadId', authenticateRequest, async (req, res) => {
  try {
    const { threadId } = req.params;
    const db = await getDb();
    
    if (!db) {
      return res.json({ threadId, messages: [] });
    }
    
    const messagesResult = await db.query(
      'SELECT role, content, created_at FROM messages WHERE thread_id = $1 ORDER BY created_at ASC',
      [threadId]
    );
    
    res.json({
      threadId,
      messages: messagesResult.rows,
    });
    
  } catch (error) {
    console.error('[Threads] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

app.get('/v1/threads', authenticateRequest, async (req, res) => {
  try {
    const { userEmail, limit = 20 } = req.query;
    const db = await getDb();
    
    if (!db || !userEmail) {
      return res.json({ threads: [] });
    }
    
    const result = await db.query(
      'SELECT id, title, created_at, updated_at FROM threads WHERE user_email = $1 ORDER BY updated_at DESC LIMIT $2',
      [userEmail, parseInt(limit)]
    );
    
    res.json({ threads: result.rows });
    
  } catch (error) {
    console.error('[Threads] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

app.listen(PORT, () => {
  console.log(`[Bo Gateway] Running on port ${PORT}`);
  console.log(`[Bo Gateway] Environment: ${process.env.NODE_ENV || 'development'}`);
  
  getDb().catch(err => {
    console.warn('[Database] Initial connection failed:', err.message);
  });
});
