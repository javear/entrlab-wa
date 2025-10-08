import mongoose, { Schema, Document } from 'mongoose';

// ============================================
// User Pause Model
// Manages paused users per client
// ============================================

export interface IUserPause extends Document {
  clientId: string;
  phoneNumber: string;
  paused: boolean;
  paused_at: Date;
  paused_till: Date;
  pause_reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserPauseSchema: Schema = new Schema(
  {
    clientId: {
      type: String,
      required: true,
      index: true
    },
    phoneNumber: {
      type: String,
      required: true,
      index: true
    },
    paused: {
      type: Boolean,
      required: true,
      default: true
    },
    paused_at: {
      type: Date,
      required: true,
      default: Date.now
    },
    paused_till: {
      type: Date,
      required: true
    },
    pause_reason: {
      type: String,
      required: false
    }
  },
  {
    timestamps: true,
    collection: 'client_user_pauses'
  }
);

// Compound index for fast lookups
UserPauseSchema.index({ clientId: 1, phoneNumber: 1 }, { unique: true });

// Index for cleaning up expired pauses
UserPauseSchema.index({ paused_till: 1 });

export const UserPause = mongoose.model<IUserPause>('UserPause', UserPauseSchema);

