import { Friend, Group, Sendable } from './index';
import type { MessageElem } from '@icqqjs/icqq';
import type { Receive } from 'node-napcat-ts';
import { NapCatForwardElem } from '../NapCatClient/convert';

export abstract class ChatEvent {
  protected constructor(
    public readonly chat: Friend | Group,
  ) {
  }

  public get dm() {
    return 'uin' in this.chat;
  }

  public get chatId() {
    if ('uin' in this.chat)
      return this.chat.uin;
    return -this.chat.gid;
  }
}

export class MessageEvent extends ChatEvent {
  constructor(
    public readonly from: {
      id: number;
      name: string;
      nickname?: string;
      card?: string;
    },
    chat: Friend | Group,
    public readonly message: (MessageElem | NapCatForwardElem)[],
    public readonly seq: number,
    public readonly rand: number,
    public readonly pktnum: number,
    public readonly time: number,
    public readonly brief: string,
    public readonly replyTo: {
      fromId: number;
      time: number;
      seq: number;
      rand: number;
      message: (MessageElem | NapCatForwardElem)[];
    },
    public readonly anonymous: {
      name: string;
    } | undefined,
    // use only in fetchMsg
    public readonly messageId: string,
    public readonly atMe: boolean,
    public readonly atAll: boolean,
    public readonly tempChatFromGroupId?: number,
  ) {
    super(chat);
  }

  public reply(content: Sendable, replyTo = true) {
    return this.chat.sendMsg(content, replyTo ? {
      message: this.message as any,
      seq: this.seq,
      rand: this.rand,
      time: this.time,
      user_id: this.from.id,
    } : undefined);
  }
}

export class GroupMemberIncreaseEvent extends ChatEvent {
  constructor(
    group: Group,
    public readonly userId: number,
    public readonly nickname: string,
  ) {
    super(group);
  }
}

export class GroupMemberDecreaseEvent extends ChatEvent {
  constructor(
    group: Group,
    public readonly userId: number,
    public readonly operatorId: number,
    public readonly dismiss: boolean,
  ) {
    super(group);
  }
}

export class FriendIncreaseEvent {
  constructor(
    public readonly friend: Friend,
  ) {
  }
}

export class MessageRecallEvent {
  constructor(
    public readonly chat: Friend | Group,
    public readonly seq: number,
    public readonly rand: number,
    public readonly time: number,
  ) {
  }
}

export class PokeEvent extends ChatEvent {
  constructor(
    chat: Friend | Group,
    public readonly fromId: number,
    public readonly targetId: number,
    public readonly action: string,
    public readonly suffix: string,
  ) {
    super(chat);
  }
}
