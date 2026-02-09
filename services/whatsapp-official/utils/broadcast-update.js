const mongoose = require('mongoose');

let PlatformClientBroadcast;
try {
  PlatformClientBroadcast = mongoose.model('PlatformClientBroadcast');
} catch {
  const Schema = mongoose.Schema;
  PlatformClientBroadcast = mongoose.model('PlatformClientBroadcast', new Schema({
    broadcast_uuid: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    agentCode: { type: String, required: true },
    counter: {
      recipients_total: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      read: { type: Number, default: 0 },
      reply: { type: Number, default: 0 }
    },
    target_activities: [{
      userIdentifier: { type: String, required: true },
      events: [{
        type: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
        contents: [{
          messageType: { type: String },
          content: { type: String },
          mediaUrl: { type: String },
          caption: { type: String }
        }]
      }]
    }]
  }, { timestamps: true }));
}

async function updateBroadcastDelivered(broadcastUuid, userIdentifier) {
  try {
    const result = await PlatformClientBroadcast.findOneAndUpdate(
      { broadcast_uuid: broadcastUuid },
      {
        $inc: { 'counter.delivered': 1 },
        $push: {
          'target_activities.$[elem].events': {
            type: 'delivered',
            createdAt: new Date(),
            contents: []
          }
        }
      },
      {
        arrayFilters: [{ 'elem.userIdentifier': userIdentifier }],
        new: true
      }
    );
    if (result) {
      console.log(`✅ [Broadcast] Updated delivered for ${broadcastUuid} (user: ${userIdentifier})`);
    }
  } catch (err) {
    console.warn('⚠️ [Broadcast] Failed to update delivered:', err.message);
  }
}

module.exports = { updateBroadcastDelivered };
