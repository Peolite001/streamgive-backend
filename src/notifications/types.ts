export type NotificationEvent =
  | {
      type: 'stream_created';
      streamId: string;
      donorAddress: string;
      ngoId: string;
      eventId?: string;
    }
  | { type: 'stream_withdrawn'; streamId: string; amount: string; eventId?: string }
  | {
      type: 'stream_cancelled';
      streamId: string;
      settledToNgo: string;
      refundToDonor: string;
      eventId?: string;
    }
  | { type: 'ngo_approved'; ownerAddress: string; ngoId: string; eventId?: string }
  | { type: 'ngo_revoked'; ownerAddress: string; ngoId: string; eventId?: string };
