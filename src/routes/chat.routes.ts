import { Router } from 'express';
import { ChatController } from '../controllers/chat.controller';

export function createChatRoutes(chatController: ChatController): Router {
    const router = Router();

    // Chat API Routes
    // GET /api/v1/platform/chat/broadcasts?limit=20&offset=0
    router.get('/broadcasts', (req, res) => chatController.getBroadcasts(req, res));

    // GET /api/v1/platform/chat/conversations?userIdentifier=xxx&limit=20&offset=0
    router.get('/conversations', (req, res) => chatController.getUserConversations(req, res));
    
    // GET /api/v1/platform/chat/conversations/:conversationId/chats?limit=50&offset=0
    router.get('/conversations/:conversationId/chats', (req, res) => chatController.getConversationChats(req, res));
    
    // POST /api/v1/platform/chat/conversations/:conversationId/messages
    router.post('/conversations/:conversationId/messages', (req, res) => chatController.postChatMessage(req, res));

    // PUT /api/v1/platform/chat/conversations/:hashedId/:action (block, pause, release, taken)
    router.put('/conversations/:hashedId/:action', (req, res) => chatController.setConversationNeedAttention(req, res));

    // GET /api/v1/platform/chat/contacts?limit=20&offset=0&q=searchquery
    router.get('/contacts', (req, res) => chatController.getContacts(req, res));

    // POST /api/v1/platform/chat/contacts (bulk create)
    router.post('/contacts', (req, res) => chatController.createContacts(req, res));

    // PUT /api/v1/platform/chat/contacts (single update)
    router.put('/contacts', (req, res) => chatController.updateContact(req, res));

    // DELETE /api/v1/platform/chat/contacts (bulk delete)
    router.delete('/contacts', (req, res) => chatController.deleteContacts(req, res));

    return router;
}
