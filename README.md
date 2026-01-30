# Bo Gateway

The Render service that IS Bo — Taptico's AI assistant endpoint.

## Architecture

```
BoChat UI (Manus) → Bo Gateway (Render) → Claude API
                         ↓
                   PostgreSQL (Render)
                   (conversation threads)
```

## Bo's Personality

- **Tough-love**: Supportive but honest. Calls out bad ideas directly.
- **Accountable**: Tracks commitments and deadlines. Calls out drift.
- **Supportive of wins**: Celebrates successes genuinely, doesn't over-hype.
- **10th-grader explanations**: Technical topics explained clearly, no unexplained jargon.

## API Contract

### POST `/v1/chat`

**Headers:**
```
Content-Type: application/json
X-BOCHAT-API-KEY: <shared-secret>
```

**Request Body:**
```json
{
  "userEmail": "nick@taptico.com",
  "message": "Hello Bo",
  "threadId": "optional-thread-id"
}
```

**Response:**
```json
{
  "reply": "Bo's response text",
  "threadId": "thread-id-for-continuation"
}
```

### GET `/v1/threads/:threadId`

Get full conversation history for a thread.

### GET `/v1/threads?userEmail=nick@taptico.com`

List user's conversation threads.

### GET `/health`

Public health check endpoint.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOCHAT_API_KEY` | Yes | Shared secret for X-BOCHAT-API-KEY header |
| `LLM_API_KEY` | Yes | Anthropic API key |
| `DATABASE_URL` | Yes | Render Postgres connection string |
| `LLM_MODEL` | No | Claude model (default: claude-sonnet-4-20250514) |

## Deployment to Render

1. Create GitHub repo: `tapticocorp/bo-gateway`
2. Push this code to the repo
3. In Render: New + → Web Service → Connect to repo
4. Settings:
   - **Name:** `bo-gateway`
   - **Region:** Virginia (US East)
   - **Runtime:** Node
   - **Build:** `npm install`
   - **Start:** `npm start`
5. Add environment variables
6. Deploy!

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your values
npm run dev
```

## Testing

```bash
curl -X POST http://localhost:3000/v1/chat \
  -H "Content-Type: application/json" \
  -H "X-BOCHAT-API-KEY: your_shared_secret" \
  -d '{
    "userEmail": "nick@taptico.com",
    "message": "Hello Bo!"
  }'
```
