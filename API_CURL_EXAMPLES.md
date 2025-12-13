# WhatsApp Bot API - cURL Examples

Base URL: `http://localhost:3003` (default port, adjust if different)

## 🚀 Client Management

### Create a New Client
```bash
curl -X POST http://localhost:3003/api/whatsapp/clients \
  -H "Content-Type: application/json" \
  -d '{
    "clientId": "my-whatsapp-client"
  }'
```

### List All Clients
```bash
curl http://localhost:3003/api/whatsapp/clients
```

### Get Client Status
```bash
curl http://localhost:3003/api/whatsapp/clients/my-whatsapp-client
```

### Delete Client (Permanently - Deletes All Session Data)
```bash
curl -X DELETE http://localhost:3003/api/whatsapp/clients/my-whatsapp-client
```

**Note:** This endpoint permanently deletes:
- The client from memory
- Local session folder (`tokens/{clientId}/`)
- MongoDB GridFS session backups
- WPPConnect tokens

After deletion, the client will NOT be recreated on restart.

## 📱 QR Code Management

### Get QR Code Image (Base64 PNG)
```bash
curl http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/qr-image
```

## 💬 Message Operations

### Send Message
```bash
curl -X POST http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/send \
  -H "Content-Type: application/json" \
  -d '{
    "number": "6281234567890",
    "message": "Hello from WhatsApp Bot!"
  }'
```

### Send Message with Media
```bash
curl -X POST http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/send \
  -H "Content-Type: application/json" \
  -d '{
    "number": "6281234567890",
    "message": "Check out this image: https://example.com/image.jpg"
  }'
```

## 🤖 Agent Assignment

### Assign Agent to Client
```bash
curl -X PUT http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/agent \
  -H "Content-Type: application/json" \
  -d '{
    "agentCode": "my-agent-code"
  }'
```

### Get Agent Assignment
```bash
curl http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/agent
```

### Remove Agent Assignment
```bash
curl -X DELETE http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/agent
```

### List All Agent Assignments
```bash
curl http://localhost:3003/api/whatsapp/agents
```

## ⏸️ User Pause Management

### Pause a User
```bash
curl -X POST http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/pause \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "6281234567890"
  }'
```

### Unpause a User
```bash
curl -X DELETE http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/pause/6281234567890
```

### Get User Pause Status
```bash
curl http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/pause/6281234567890
```

### List All Paused Users for a Client
```bash
curl http://localhost:3003/api/whatsapp/clients/my-whatsapp-client/pauses
```

## 🏥 Health & Status

### WhatsApp Service Health
```bash
curl http://localhost:3003/api/whatsapp/health
```

### System Health Check
```bash
curl http://localhost:3003/health
```

## 📝 Complete Workflow Example

### 1. Create Client
```bash
curl -X POST http://localhost:3003/api/whatsapp/clients \
  -H "Content-Type: application/json" \
  -d '{"clientId": "test-client"}'
```

### 2. Get QR Code for Authentication
```bash
curl http://localhost:3003/api/whatsapp/clients/test-client/qr-image
# Save the base64 image and scan with WhatsApp
```

### 3. Check Client Status (wait until ready)
```bash
curl http://localhost:3003/api/whatsapp/clients/test-client
# Wait until status is "ready" and isReady is true
```

### 4. Assign Agent
```bash
curl -X PUT http://localhost:3003/api/whatsapp/clients/test-client/agent \
  -H "Content-Type: application/json" \
  -d '{"agentCode": "my-agent"}'
```

### 5. Send a Message
```bash
curl -X POST http://localhost:3003/api/whatsapp/clients/test-client/send \
  -H "Content-Type: application/json" \
  -d '{
    "number": "6281234567890",
    "message": "Hello from the bot!"
  }'
```

### 6. Delete Client When Done
```bash
curl -X DELETE http://localhost:3003/api/whatsapp/clients/test-client
```

## 🔧 Response Examples

### Successful Client Creation
```json
{
  "success": true,
  "message": "Client created successfully",
  "data": {
    "clientId": "my-whatsapp-client",
    "status": "initializing",
    "isReady": false,
    "hasQrCode": false,
    "lastActivity": "2025-01-01T12:00:00.000Z"
  }
}
```

### Successful Client Deletion
```json
{
  "success": true,
  "message": "WPPConnect client removed successfully (all session data deleted permanently)"
}
```

### Client Status (Ready)
```json
{
  "success": true,
  "message": "Client status retrieved successfully",
  "data": {
    "clientId": "my-whatsapp-client",
    "status": "ready",
    "isReady": true,
    "phoneNumber": "6281234567890@c.us",
    "hasQrCode": false,
    "lastActivity": "2025-01-01T12:00:00.000Z"
  }
}
```

## ⚠️ Error Responses

### Client Not Found (404)
```json
{
  "success": false,
  "message": "WPPConnect client not found"
}
```

### Bad Request (400)
```json
{
  "success": false,
  "message": "clientId is required"
}
```

### Internal Server Error (500)
```json
{
  "success": false,
  "message": "Failed to remove WPPConnect client",
  "error": "Error details here"
}
```


