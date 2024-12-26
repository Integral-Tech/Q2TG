import Instance from '../models/Instance';
import Telegram from '../client/Telegram';
import { MiraiElem } from '@icqqjs/icqq';
import { MessageEvent, QQClient } from '../client/QQClient';
import { Api } from 'telegram';
import lottie from '../constants/lottie';

export default class {
  constructor(private readonly instance: Instance,
              private readonly tgBot: Telegram,
              private readonly tgUser: Telegram,
              private readonly qqBot: QQClient) {
    this.initStickerPack();
    tgBot.addNewMessageEventHandler(this.onTelegramMessage);
  }

  private stickerPackHandles: Api.TypeDocument[] = null;

  private async initStickerPack() {
    const pack = await this.tgBot.getStickerSet('Clansty_WEBM');
    this.stickerPackHandles = pack.documents;
  }

  private onTelegramMessage = async (message: Api.Message) => {
    if ((message.isGroup || message.isChannel) && this.instance.workMode === 'group') return;
    if (this.stickerPackHandles)
      await message.reply({
        file: this.stickerPackHandles[0],
      });
    await message.reply({
      message: 'Q2TG 还在初始化中，所以暂时无法处理你的消息。请稍后再试',
    });
    return true;
  };

  public off() {
    this.tgBot.removeNewMessageEventHandler(this.onTelegramMessage);
  }
}
