const mongoose = require('mongoose');

let PlatformClientBroadcast;
let mongoConnected = false;

async function ensureMongo() {
  if (mongoConnected && mongoose.connection.readyState === 1) return;
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) return;
  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(uri);
    }
    mongoConnected = mongoose.connection.readyState === 1;
  } catch (err) {
    console.warn('⚠️ [Broadcast] MongoDB connect failed:', err.message);
  }
}

function getBroadcastModel() {
  try {
    return mongoose.model('PlatformClientBroadcast');
  } catch {
    const Schema = mongoose.Schema;
    return mongoose.model('PlatformClientBroadcast', new Schema({
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
}

async function updateBroadcastRead(broadcastUuid, userIdentifier) {
  await ensureMongo();
  if (!mongoConnected) return;
  try {
    const Model = getBroadcastModel();
    const result = await Model.findOneAndUpdate(
      { broadcast_uuid: broadcastUuid },
      {
        $inc: { 'counter.read': 1 },
        $push: {
          'target_activities.$[elem].events': {
            type: 'read',
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
      console.log(`✅ [Broadcast] Updated read for ${broadcastUuid} (user: ${userIdentifier})`);
    }
  } catch (err) {
    console.warn('⚠️ [Broadcast] Failed to update read:', err.message);
  }
}

async function updateBroadcastReply(broadcastUuid, userIdentifier, contents) {
  await ensureMongo();
  if (!mongoConnected) return;
  try {
    const Model = getBroadcastModel();
    const result = await Model.findOneAndUpdate(
      { broadcast_uuid: broadcastUuid },
      {
        $inc: { 'counter.reply': 1 },
        $push: {
          'target_activities.$[elem].events': {
            type: 'reply',
            createdAt: new Date(),
            contents: contents || []
          }
        }
      },
      {
        arrayFilters: [{ 'elem.userIdentifier': userIdentifier }],
        new: true
      }
    );
    if (result) {
      console.log(`✅ [Broadcast] Updated reply for ${broadcastUuid} (user: ${userIdentifier})`);
    }
  } catch (err) {
    console.warn('⚠️ [Broadcast] Failed to update reply:', err.message);
  }
}

module.exports = { updateBroadcastRead, updateBroadcastReply };
