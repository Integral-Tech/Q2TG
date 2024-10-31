import { Friend, Group, QQClient } from '../client/QQClient';
import TelegramChat from '../client/TelegramChat';
import Telegram from '../client/Telegram';
import db from './db';
import { Entity } from 'telegram/define';
import { BigInteger } from 'big-integer';
import { Pair } from './Pair';
import { getLogger, Logger } from 'log4js';
import Instance from './Instance';
import OicqClient from '../client/OicqClient';

export default class ForwardPairs {
  private pairs: Pair[] = [];
  private readonly log: Logger;

  private constructor(private readonly instanceId: number) {
    this.log = getLogger(`ForwardPairs - ${instanceId}`);
  }

  // 在 forwardController 创建时初始化
  private async init(oicq: QQClient, tgBot: Telegram, tgUser: Telegram) {
    const dbValues = await db.forwardPair.findMany({
      where: { instanceId: this.instanceId },
    });
    for (const i of dbValues) {
      try {
        const qq = await oicq.getChat(Number(i.qqRoomId), i.qqFromGroupId ? Number(i.qqFromGroupId) : undefined);
        const tg = await tgBot.getChat(Number(i.tgChatId));
        const tgUserChat = await tgUser.getChat(Number(i.tgChatId));
        if (qq && tg && tgUserChat) {
          this.log.debug('初始化', { qq, tg, tgUserChat });
          this.pairs.push(new Pair(qq, tg, tgUserChat, i.id, i.flags, i.apiKey, oicq));
        }
      }
      catch (e) {
        this.log.warn(`初始化遇到问题，QQ: ${i.qqRoomId} TG: ${i.tgChatId}`);
      }
    }
  }

  public static async load(instanceId: number, oicq: QQClient, tgBot: Telegram, tgUser: Telegram) {
    const instance = new this(instanceId);
    await instance.init(oicq, tgBot, tgUser);
    return instance;
  }

  public async add(qq: Friend | Group, tg: TelegramChat, tgUser: TelegramChat, qqClient: QQClient, qqFromGroupId?: number) {
    const dbEntry = await db.forwardPair.create({
      data: {
        qqRoomId: 'uid' in qq ? qq.uid : -qq.gid,
        tgChatId: Number(tg.id),
        instanceId: this.instanceId,
        qqFromGroupId,
      },
    });
    this.pairs.push(new Pair(qq, tg, tgUser, dbEntry.id, dbEntry.flags, dbEntry.apiKey, qqClient));
    return dbEntry;
  }

  public async remove(pair: Pair) {
    this.pairs.splice(this.pairs.indexOf(pair), 1);
    await db.forwardPair.delete({
      where: { id: pair.dbId },
    });
  }

  public find(target: Friend | Group | TelegramChat | Entity | number | BigInteger) {
    if (!target) return null;
    if (typeof target === 'object' && 'uid' in target) {
      return this.pairs.find(e => 'uid' in e.qq && e.qq.uid === target.uid);
    }
    else if (typeof target === 'object' && 'gid' in target) {
      return this.pairs.find(e => 'gid' in e.qq && e.qq.gid === target.gid);
    }
    else if (typeof target === 'number' || 'eq' in target) {
      return this.pairs.find(e => e.qqRoomId === target || e.tg.id.eq(target));
    }
    else {
      return this.pairs.find(e => e.tg.id.eq(target.id));
    }
  }

  public async initMapInstance(instances: Instance[]) {
    for (const forwardPair of this.pairs) {
      for (const instance of instances) {
        if (!(instance.oicq instanceof OicqClient)) continue;
        const instanceTgUserId = instance.userMe.id.toString();
        if (forwardPair.instanceMapForTg[instanceTgUserId]) continue;
        try {
          const group = await instance.oicq.getChat(forwardPair.qqRoomId) as Group;
          if (!group) continue;
          forwardPair.instanceMapForTg[instanceTgUserId] = group;
          this.log.info('MapInstance', { group: forwardPair.qqRoomId, tg: instanceTgUserId, qq: instance.qqUin });
        }
        catch {
        }
      }
    }
  }
}
