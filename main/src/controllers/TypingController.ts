import Instance from '../models/Instance';
import Telegram from '../client/Telegram';
import { InputStatusChangeEvent, QQClient } from '../client/QQClient';
import flags from '../constants/flags';
import { Api } from 'telegram';

export default class TypingController {
  constructor(private readonly instance: Instance,
              private readonly tgBot: Telegram,
              private readonly tgUser: Telegram,
              private readonly oicq: QQClient) {
    oicq.addInputStatusChangeHandler(this.handleInputStatusChange);
  }

  private handleInputStatusChange = async (event: InputStatusChangeEvent) => {
    const pair = this.instance.forwardPairs.find(event.chat);
    if (!pair) return;
    if (pair.flags & flags.DISABLE_Q2TG) return;

    if (event.typing) {
      console.log(await pair.tg.setTyping())

    }
    else {
      await pair.tg.setTyping(new Api.SendMessageCancelAction());
    }
  };
}
