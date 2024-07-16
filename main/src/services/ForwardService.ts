import Telegram from '../client/Telegram';
import {
  FaceElem,
  Group as OicqGroup,
  Friend as OicqFriend,
  PttElem,
  Quotable,
  segment,
} from '@icqqjs/icqq';
import { fetchFile, getBigFaceUrl, getImageUrlByMd5, isContainsUrl } from '../utils/urls';
import { ButtonLike, FileLike } from 'telegram/define';
import { getLogger, Logger } from 'log4js';
import path from 'path';
import exts from '../constants/exts';
import helper from '../helpers/forwardHelper';
import db from '../models/db';
import { Button } from 'telegram/tl/custom/button';
import { SendMessageParams } from 'telegram/client/messages';
import { Api } from 'telegram';
import { file as createTempFileBase, FileResult } from 'tmp-promise';
import eviltransform from 'eviltransform';
import silk from '../encoding/silk';
import axios from 'axios';
import { md5Hex } from '../utils/hashing';
import Instance from '../models/Instance';
import { Pair } from '../models/Pair';
import OicqClient from '../client/OicqClient';
import lottie from '../constants/lottie';
import _ from 'lodash';
import emoji from '../constants/emoji';
import convert from '../helpers/convert';
import { QQMessageSent } from '../types/definitions';
import ZincSearch from 'zincsearch-node';
import Docker from 'dockerode';
import ReplyKeyboardHide = Api.ReplyKeyboardHide;
import env from '../models/env';
import { CustomFile } from 'telegram/client/uploads';
import flags from '../constants/flags';
import BigInteger from 'big-integer';
import pastebin from '../utils/pastebin';
import { MessageEvent, QQClient, Sendable, SendableElem } from '../client/QQClient';
import posthog from '../models/posthog';
import { NapCatClient } from '../client/NapCatClient';

const NOT_CHAINABLE_ELEMENTS = ['flash', 'record', 'video', 'location', 'share', 'json', 'xml', 'poke'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/apng', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/x-icon', 'image/avif', 'image/heic', 'image/heif'];

const createTempFile = (options: Parameters<typeof createTempFileBase>[0] = {}) => createTempFileBase({
  tmpdir: env.CACHE_DIR,
  ...options,
});

// noinspection FallThroughInSwitchStatementJS
export default class ForwardService {
  private readonly log: Logger;
  private readonly zincSearch: ZincSearch;
  private readonly restartSignCallbackHandle?: Buffer;

  constructor(private readonly instance: Instance,
              private readonly tgBot: Telegram,
              private readonly oicq: QQClient) {
    this.log = getLogger(`ForwardService - ${instance.id}`);
    if (env.ZINC_URL) {
      this.zincSearch = new ZincSearch({
        url: env.ZINC_URL,
        user: env.ZINC_USERNAME,
        password: env.ZINC_PASSWORD,
      });
    }
    if (oicq instanceof OicqClient && oicq.signDockerId) {
      const socket = new Docker({ socketPath: '/var/run/docker.sock' });
      const container = socket.getContainer(oicq.signDockerId);
      this.restartSignCallbackHandle = tgBot.registerCallback(async (event) => {
        const message = await event.edit({
          message: event.messageId,
          text: '正在重启签名服务...',
          buttons: new ReplyKeyboardHide({}),
        });
        await container.restart();
        await event.answer({
          message: '已发送重启指令',
        });
        await message.reply({
          message: '已发送重启指令\n你需要稍后重新发送一下消息',
        });
      });
    }
    this.initStickerPack().then(() => this.log.info('Sticker Pack 初始化完成'));
  }

  private readonly stickerPackMap: Record<keyof typeof lottie.packInfo, Api.Document[]> = {} as any;

  private async initStickerPack() {
    for (const handle of Object.keys(lottie.packInfo)) {
      const pack = await this.tgBot.getStickerSet(handle);
      this.stickerPackMap[handle] = pack.documents;
    }
  }

  private getStickerByQQFaceId(id: number) {
    for (const [pack, ids] of Object.entries(lottie.packInfo)) {
      if (ids.includes(id as any)) {
        if (this.stickerPackMap[pack])
          return this.stickerPackMap[pack][ids.indexOf(id)] as Api.Document;
      }
    }
  }

  private getFaceByTgFileId(fileId: BigInteger.BigNumber): FaceElem | undefined {
    for (const [pack, documents] of Object.entries(this.stickerPackMap)) {
      for (const document of documents) {
        if (document.id.eq(fileId))
          return {
            type: 'face',
            id: lottie.packInfo[pack][documents.indexOf(document)],
            stickerType: 1,
          };
      }
    }
  }

  public async forwardFromQq(event: MessageEvent, pair: Pair) {
    const tempFiles: FileResult[] = [];
    try {
      let message = '',
        files: FileLike[] = [],
        buttons: ButtonLike[] = [],
        replyTo = 0,
        forceDocument = false;
      let messageHeader = '', sender = '';
      if (!event.dm) {
        // 产生头部，这和工作模式没有关系
        sender = event.from.name;
        if (event.anonymous) {
          sender = `[${sender}]${event.anonymous.name}`;
        }
        if ((pair.flags | this.instance.flags) & flags.COLOR_EMOJI_PREFIX) {
          messageHeader += emoji.color(event.from.id);
        }
        messageHeader += `<b>${helper.htmlEscape(sender)}</b>: `;
      }
      const useSticker = (file: FileLike) => {
        files.push(file);
        if (!event.dm) {
          buttons.push(Button.inline(`${sender}:`));
          messageHeader = '';
        }
      };
      const useForward = async (resId: string) => {
        if (env.CRV_API) {
          try {
            const messages = await pair.qq.getForwardMsg(resId);
            message = helper.generateForwardBrief(messages);
            const hash = md5Hex(resId);
            const viewerUrl = env.CRV_VIEWER_APP ? `${env.CRV_VIEWER_APP}?startapp=${hash}` : `${env.CRV_API}/?hash=${hash}`;
            buttons.push(Button.url('📃查看', viewerUrl));
            // 传到 Cloudflare
            axios.post(`${env.CRV_API}/add`, {
              auth: env.CRV_KEY,
              key: hash,
              data: messages,
            })
              .then(data => this.log.trace('上传消息记录到 Cloudflare', data.data))
              .catch(e => {
                this.log.error('上传消息记录到 Cloudflare 失败', e);
                posthog.capture('上传消息记录到 Cloudflare 失败', { error: e });
              });
          }
          catch (e) {
            posthog.capture('转发多条消息（无法获取）', { error: e });
            message = '[<i>转发多条消息（无法获取）</i>]';
          }
        }
        else {
          message = '[<i>转发多条消息（未配置）</i>]';
        }
      };
      for (let elem of event.message) {
        if (elem.type === 'flash' && (pair.flags | this.instance.flags) & flags.NO_FLASH_PIC) {
          message += '<i>[闪照]</i>';
          elem = {
            ...elem,
            type: 'image',
          };
        }
        let url: string;
        switch (elem.type) {
          case 'text': {
            // 判断微信文章
            const WECHAT_ARTICLE_REGEX = /https?:\/\/mp\.weixin\.qq\.com\/[0-9a-zA-Z\-_+=&?#\/]+/;
            if (WECHAT_ARTICLE_REGEX.test(elem.text)) {
              const instantViewUrl = new URL('https://t.me/iv');
              instantViewUrl.searchParams.set('url', WECHAT_ARTICLE_REGEX.exec(elem.text)[0]);
              instantViewUrl.searchParams.set('rhash', '45756f9b0bb3c6');
              message += `<a href="${instantViewUrl}">\u200e</a>`;
            }
            message += helper.htmlEscape(elem.text);
            break;
          }
          case 'at': {
            if (event.replyTo?.fromId === elem.qq || event.replyTo?.fromId === this.oicq.uin)
              break;
            if (env.WEB_ENDPOINT && typeof elem.qq === 'number') {
              message += `<a href="${helper.generateRichHeaderUrl(pair.apiKey, elem.qq)}">[<i>${helper.htmlEscape(elem.text)}</i>]</a>`;
              break;
            }
          }
          case 'face':
            // 判断 tgs 表情
            const tgs = this.getStickerByQQFaceId(elem.id as number);
            if (tgs) {
              useSticker(tgs);
              break;
            }
          case 'sface': {
            if (!elem.text) {
              elem.text = '表情:' + elem.id;
            }
            message += `[<i>${helper.htmlEscape(elem.text)}</i>]`;
            break;
          }
          case 'bface': {
            useSticker(await convert.webp(elem.file, () => fetchFile(getBigFaceUrl(elem.file))));
            break;
          }
          case 'video':
            // 先获取 URL，要传给下面
            url = await pair.qq.getVideoUrl(elem.fid, elem.md5);
          case 'image':
            if ('url' in elem)
              url = elem.url;
            try {
              if (elem.type === 'image' && elem.asface
                && !(elem.file as string).toLowerCase().endsWith('.gif')
                // 同时存在文字消息就不作为 sticker 发送
                && !event.message.some(it => it.type === 'text')
                // 防止在 TG 中一起发送多个 sticker 失败
                && event.message.filter(it => it.type === 'image').length === 1
              ) {
                useSticker(await convert.webp(elem.file as string, () => fetchFile(elem.url)));
              }
              else {
                const file = await helper.downloadToCustomFile(url, !(message || messageHeader));
                files.push(file);
                if (file instanceof CustomFile && elem.type === 'image' && file.size > 10 * 1024 * 1024) {
                  this.log.info('强制使用文件发送');
                  forceDocument = true;
                }
                buttons.push(Button.url(`${emoji.picture()} 查看原图`, url));
              }
            }
            catch (e) {
              this.log.error('下载媒体失败', e);
              posthog.capture('下载媒体失败', { error: e });
              // 下载失败让 Telegram 服务器下载
              files.push(url);
            }
            break;
          case 'flash': {
            message += `[<i>闪照<i>]\n${this.instance.workMode === 'group' ? '每人' : ''}只能查看一次`;
            const dbEntry = await db.flashPhoto.create({
              data: { photoMd5: (elem.file as string).substring(0, 32) },
            });
            buttons.push(Button.url('📸查看', `https://t.me/${this.tgBot.me.username}?start=flash-${dbEntry.id}`));
            break;
          }
          case 'file': {
            // 50M 以下文件下载转发
            message = `文件: ${helper.htmlEscape(elem.name)}\n` +
              `大小: ${helper.hSize(elem.size)}`;
            if (elem.size < 1024 * 1024 * 50) {
              try {
                let url = await pair.qq.getFileUrl(elem.fid); // NapCat 这一步会下载文件并返回本地路径
                if (url.includes('?fname=')) {
                  url = url.split('?fname=')[0];
                  // 防止 Request path contains unescaped characters
                }
                this.log.info('正在发送媒体，长度', helper.hSize(elem.size));
                try {
                  const file = await helper.downloadToCustomFile(url, !(message || messageHeader), elem.name);
                  if (file instanceof CustomFile && file.size > 10 * 1024 * 1024) {
                    this.log.info('强制使用文件发送');
                    forceDocument = true;
                  }
                  files.push(file);
                }
                catch (e) {
                  // 处理 helper.downloadToCustomFile 异常
                  this.log.error('下载媒体失败', e);
                  posthog.capture('下载媒体失败', { error: e });
                  // 下载失败让 Telegram 服务器下载
                  if (/https?:\/\//.test(url)) {
                    files.push(url);
                  }
                  else {
                    message += '\n\n<i>下载失败</i>';
                  }
                }
              }
              catch (e) {
                // 处理 NapCat 下载文件失败
                this.log.error('QQ 客户端处理群文件失败', e);
                posthog.capture('QQ 客户端处理群文件失败', { error: e });
                message += '\n\n<i>QQ 客户端处理群文件失败</i>';
              }
            }
            const dbEntry = await db.file.create({
              data: { fileId: elem.fid, roomId: pair.qqRoomId, info: message },
            });
            if (this.oicq instanceof OicqClient) {
              buttons.push(Button.url('📎获取下载地址',
                `https://t.me/${this.tgBot.me.username}?start=file-${dbEntry.id}`));
            }
            break;
          }
          case 'record': {
            const temp = await createTempFile({ postfix: '.ogg' });
            tempFiles.push(temp);
            url = elem.url;
            if (!url && this.oicq instanceof OicqClient) {
              const refetchMessage = await this.oicq.oicq.getMsg(event.messageId);
              url = (refetchMessage.message.find(it => it.type === 'record') as PttElem).url;
            }
            await silk.decode(await fetchFile(url), temp.path);
            files.push(temp.path);
            break;
          }
          case 'share': {
            message = helper.htmlEscape(elem.url);
            break;
          }
          case 'json': {
            const result = helper.processJson(elem.data);
            switch (result.type) {
              case 'text':
                message = helper.htmlEscape(result.text);
                break;
              case 'forward':
                await useForward(result.resId);
                break;
            }
            break;
          }
          case 'xml': {
            const result = helper.processXml(elem.data);
            switch (result.type) {
              case 'text':
                message = helper.htmlEscape(result.text);
                break;
              case 'image':
                try {
                  files.push(await helper.downloadToCustomFile(getImageUrlByMd5(result.md5)));
                }
                catch (e) {
                  this.log.error('下载媒体失败', e);
                  posthog.capture('下载媒体失败', { error: e });
                  // 下载失败让 Telegram 服务器下载
                  files.push(getImageUrlByMd5(result.md5));
                }
                break;
              case 'forward':
                await useForward(result.resId);
                break;
            }
            break;
          }
          case 'rps':
          case 'dice':
            message = `[<i>${elem.type === 'rps' ? '猜拳' : '骰子'}</i>] ${elem.id}`;
            break;
          case 'poke':
            message = `[<i>戳一戳</i>] ${helper.htmlEscape(elem.text)}`;
            break;
          case 'location':
            message = `[<i>位置</i>] ${helper.htmlEscape(elem.name)}\n${helper.htmlEscape(elem.address)}`;
            break;
        }
      }
      message = message.trim();

      // 处理回复
      if (event.replyTo) {
        try {
          const quote = await db.message.findFirst({
            where: {
              qqRoomId: pair.qqRoomId,
              seq: event.replyTo.seq,
              // rand: event.source.rand,
              qqSenderId: event.replyTo.fromId,
              instanceId: this.instance.id,
            },
          });
          if (quote) {
            replyTo = quote.tgMsgId;
          }
          else {
            message += '\n\n<i>*回复消息找不到</i>';
            this.log.error('回复消息找不到', {
              qqRoomId: pair.qqRoomId,
              seq: event.replyTo.seq,
              rand: event.replyTo.rand,
              qqSenderId: event.replyTo.fromId,
              instanceId: this.instance.id,
            });
          }
        }
        catch (e) {
          this.log.error('查找回复消息失败', e);
          posthog.capture('查找回复消息失败', { error: e });
          message += '\n\n<i>*查找回复消息失败</i>';
        }
      }

      if (this.instance.workMode === 'personal' && !event.dm && event.atMe && !replyTo) {
        message += `\n<b>@${this.instance.userMe.usernames?.length ?
          this.instance.userMe.usernames[0].username :
          this.instance.userMe.username}</b>`;
      }

      let richHeaderUsed = false;
      // 发送消息
      const messageToSend: SendMessageParams = {
        forceDocument: forceDocument as any, // 恼
      };
      if (files.length === 1) {
        messageToSend.file = files[0];
      }
      else if (files.length) {
        messageToSend.file = files;
      }
      else if (!event.dm && (pair.flags | this.instance.flags) & flags.RICH_HEADER && env.WEB_ENDPOINT
        // 当消息包含链接时不显示 RICH HEADER
        && !isContainsUrl(message)) {
        // 没有文件时才能显示链接预览
        richHeaderUsed = true;
        // https://github.com/tdlib/td/blob/437c2d0c6e0ad104022d5ad86ddc8aedc41cb7a8/td/telegram/MessageContent.cpp#L2575
        // https://github.com/tdlib/td/blob/437c2d0c6e0ad104022d5ad86ddc8aedc41cb7a8/td/generate/scheme/telegram_api.tl#L1841
        // https://github.com/gram-js/gramjs/pull/633
        messageToSend.file = new Api.InputMediaWebPage({
          url: helper.generateRichHeaderUrl(pair.apiKey, event.from.id, messageHeader),
          forceSmallMedia: true,
          optional: true,
        });
        messageToSend.linkPreview = { showAboveText: true };
      }

      if (!richHeaderUsed) {
        message = messageHeader + (message && messageHeader ? '\n' : '') + message;
      }
      message && (messageToSend.message = message);

      buttons.length && (messageToSend.buttons = _.chunk(buttons, 3));
      replyTo && (messageToSend.replyTo = replyTo);

      let tgMessage: Api.Message;
      try {
        tgMessage = await pair.tg.sendMessage(messageToSend);
      }
      catch (e) {
        if (richHeaderUsed) {
          richHeaderUsed = false;
          this.log.warn('Rich Header 发送错误', messageToSend.file, e);
          posthog.capture('Rich Header 发送错误', { error: e, attach: messageToSend.file });
          delete messageToSend.file;
          delete messageToSend.linkPreview;
          message = messageHeader + (message && messageHeader ? '\n' : '') + message;
          message && (messageToSend.message = message);
          tgMessage = await pair.tg.sendMessage(messageToSend);
        }
        else throw e;
      }

      if (richHeaderUsed) {
        // 测试 Web Preview 内容是否被正确获取
        setTimeout(async () => {
          // Telegram Bot 账号无法获取 Web 预览内容，只能用 User 账号获取
          const userMessage = await pair.tgUser.getMessage({
            ids: tgMessage.id,
          });
          if (['WebPage', 'WebPageNotModified'].includes((userMessage.media as Api.MessageMediaWebPage)?.webpage?.className))
            return;
          // 没有正常获取的话，就加上原先的头部
          this.log.warn('Rich Header 回测错误', messageToSend.file);
          await tgMessage.edit({
            text: messageHeader + (message && messageHeader ? '\n' : '') + message,
          });
        }, 3000);
      }

      if (this.instance.workMode === 'personal' && !event.dm && event.atAll) {
        await tgMessage.pin({ notify: false });
      }
      return { tgMessage, richHeaderUsed };
    }
    catch (e) {
      this.log.error('从 QQ 到 TG 的消息转发失败', e);
      posthog.capture('从 QQ 到 TG 的消息转发失败', { error: e });
      let pbUrl: string;
      try {
        pbUrl = await pastebin.upload(JSON.stringify({
          error: e,
          event,
        }));
      }
      catch (e) {
        this.log.error('上传到 Pastebin 失败', e);
      }
      try {
        this.instance.workMode === 'personal' && await pair.tg.sendMessage({
          message: '<i>有一条来自 QQ 的消息转发失败</i>',
          buttons: pbUrl ? [[Button.url('查看详情', pbUrl)]] : [],
        });
      }
      catch {
      }
      return {};
    }
    finally {
      tempFiles.forEach(it => it.cleanup());
    }
  }

  public async forwardFromTelegram(message: Api.Message, pair: Pair): Promise<Array<QQMessageSent>> {
    try {
      const tempFiles: FileResult[] = [];
      let chain: (string | SendableElem)[] = [];
      const senderId = Number(message.senderId || message.sender?.id);
      // 这条消息在 tg 中被回复的时候显示的
      let brief = '', isSpoilerPhoto = false;
      let messageHeader = helper.getUserDisplayName(message.sender) +
        (message.forward ? ' 转发自 ' +
          // 要是隐私设置了，应该会有这个，然后下面两个都获取不到
          (message.fwdFrom?.fromName ||
            helper.getUserDisplayName(await message.forward.getChat() || await message.forward.getSender())) :
          '');
      messageHeader += ': \n';
      if ((pair.flags | this.instance.flags) & flags.COLOR_EMOJI_PREFIX) {
        messageHeader = emoji.tgColor((message.sender as Api.User)?.color?.color || message.senderId.toJSNumber()) + messageHeader;
      }

      const useImage = (image: string | Buffer, asface: boolean) => {
        chain.push({
          type: 'image',
          file: image,
          asface,
        });
      };
      const useText = (text: string) => {
        chain.push(text);
      };

      if (message.photo instanceof Api.Photo ||
        // stickers 和以文件发送的图片都是这个
        IMAGE_MIMES.includes(message.document?.mimeType)) {
        if ('spoiler' in message.media && message.media.spoiler) {
          isSpoilerPhoto = true;

          chain.push(...await this.oicq.createSpoilerImageEndpoint({
            type: 'image',
            file: await message.downloadMedia({}),
            asface: !!message.sticker,
          }, messageHeader.substring(0, messageHeader.length - 3), message.message));

          brief += '[Spoiler 图片]';
        }
        else {
          useImage(await message.downloadMedia({}) as Buffer, !!message.sticker);
          brief += '[图片]';
        }
      }
      else if (message.video || message.videoNote || message.gif) {
        const file = message.video || message.videoNote || message.gif;
        if (file.size.gt(200 * 1024 * 1024)) {
          chain.push('[视频大于 200MB]');
        }
        else if (file.mimeType === 'video/webm' || message.gif) {
          // 把 webm 转换成 gif
          const convertedPath = await convert.webm2gif(message.document.id.toString(16), () => message.downloadMedia({}));
          useImage(convertedPath, true);
        }
        else {
          const temp = await createTempFile();
          tempFiles.push(temp);
          await message.downloadMedia({ outputFile: temp.path });
          chain.push(segment.video(temp.path));
        }
        brief += '[视频]';
      }
      else if (message.sticker) {
        // 一定是 tgs
        const face = this.getFaceByTgFileId(message.sticker.id);
        if (face) {
          chain.push(face);
        }
        else {
          const gifPath = await convert.tgs2gif(message.sticker.id.toString(16), () => message.downloadMedia({}));
          useImage(gifPath, true);
        }
        brief += '[贴纸]';
      }
      else if (message.voice) {
        const temp = await createTempFile();
        tempFiles.push(temp);
        await message.downloadMedia({ outputFile: temp.path });
        if (this.oicq instanceof OicqClient) {
          const bufSilk = await silk.encode(temp.path);
          chain.push(segment.record(bufSilk));
        }
        else if (this.oicq instanceof NapCatClient) {
          chain.push(segment.record(temp.path));
        }
        brief += '[语音]';
      }
      else if (message.poll) {
        const poll = message.poll.poll;
        useText(`${poll.multipleChoice ? '多' : '单'}选投票：\n${poll.question}`);
        chain.push('\n');
        useText(poll.answers.map(answer => ` - ${answer.text}`).join('\n'));
        brief += '[投票]';
      }
      else if (message.contact) {
        const contact = message.contact;
        useText(`名片：\n` +
          contact.firstName + (contact.lastName ? ' ' + contact.lastName : '') +
          (contact.phoneNumber ? `\n电话：${contact.phoneNumber}` : ''));
        brief += '[名片]';
      }
      else if (message.venue && message.venue.geo instanceof Api.GeoPoint) {
        // 地标
        const geo: { lat: number, lng: number } = eviltransform.wgs2gcj(message.venue.geo.lat, message.venue.geo.long);
        if (this.oicq instanceof OicqGroup || this.oicq instanceof OicqFriend) {
          chain.push(segment.location(geo.lat, geo.lng, `${message.venue.title} (${message.venue.address})`) as any);
        }
        else {
          chain.push(`[位置：${message.venue.title} (${message.venue.address})]`);
        }
        brief += `[位置：${message.venue.title}]`;
      }
      else if (message.geo instanceof Api.GeoPoint) {
        // 普通的位置，没有名字
        const geo: { lat: number, lng: number } = eviltransform.wgs2gcj(message.geo.lat, message.geo.long);
        if (this.oicq instanceof OicqGroup || this.oicq instanceof OicqFriend) {
          chain.push(segment.location(geo.lat, geo.lng, '选中的位置') as any);
        }
        else {
          chain.push(`[位置：${geo.lat} ${geo.lng}]\nhttps://uri.amap.com/marker?position=${geo.lng},${geo.lat}`);
        }
        brief += '[位置]';
      }
      else if (message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document) {
        const file = message.media.document;
        const fileNameAttribute =
          file.attributes.find(attribute => attribute instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename;
        useText(`文件：${fileNameAttribute ? fileNameAttribute.fileName : ''}\n` +
          `类型：${file.mimeType}\n` +
          `大小：${file.size}`);
        if (file.size.leq(50 * 1024 * 1024)) {
          chain.push('\n');
          if ('gid' in pair.qq) {
            useText('文件正在上传中…');
            const file = await createTempFile();
            tempFiles.push(file);
            await message.downloadMedia({ outputFile: file.path });
            pair.qq.fs.upload(file.path, '/',
              fileNameAttribute ? fileNameAttribute.fileName : 'file')
              .catch(err => {
                message.reply({ message: `上传失败：\n${err.message}` });
                posthog.capture('上传群文件失败', { error: err });
              })
              .finally(() => file.cleanup());
          }
          else if (pair.qq instanceof OicqFriend) {
            useText('文件正在上传中…');
            pair.qq.sendFile(await message.downloadMedia({}),
              fileNameAttribute ? fileNameAttribute.fileName : 'file')
              .catch(err => {
                message.reply({ message: `上传失败：\n${err.message}` });
                posthog.capture('上传好友文件失败', { error: err });
              });
          }
          else {
            await message.reply({
              message: '当前配置不支持好友文件',
            });
          }
        }
        brief += '[文件]';
        if (env.DISABLE_FILE_UPLOAD_TIP) {
          chain = [];
        }
      }

      if (message.message && !isSpoilerPhoto) {
        const emojiEntities = (message.entities || []).filter(it => it instanceof Api.MessageEntityCustomEmoji) as Api.MessageEntityCustomEmoji[];
        if (emojiEntities.length) {
          const isMessageAllEmojis = _.sum(emojiEntities.map(it => it.length)) === message.message.length;
          const newChain = [] as (string | SendableElem)[];
          let messageLeft = message.message;
          for (let i = emojiEntities.length - 1; i >= 0; i--) {
            newChain.unshift(messageLeft.substring(emojiEntities[i].offset + emojiEntities[i].length));
            messageLeft = messageLeft.substring(0, emojiEntities[i].offset);
            newChain.unshift({
              type: 'image',
              file: await convert.customEmoji(emojiEntities[i].documentId.toString(16),
                () => this.tgBot.getCustomEmoji(emojiEntities[i].documentId),
                !isMessageAllEmojis),
              asface: true,
            });
          }
          chain.push(messageLeft, ...newChain);
          brief += message.message;
        }
        // Q2TG Bot 转发的消息目前不会包含 custom emoji
        else if (message.forward?.senderId?.eq?.(this.tgBot.me.id) && /^.*: ?$/.test(message.message.split('\n')[0])) {
          // 复读了某一条来自 QQ 的消息 (Repeat as forward)
          const originalMessage = message.message.includes('\n') ?
            message.message.substring(message.message.indexOf('\n') + 1) : '';
          useText(originalMessage);
          brief += originalMessage;

          messageHeader = helper.getUserDisplayName(message.sender) + ' 转发自 ' +
            message.message.substring(0, message.message.indexOf(':')) + ': \n';
        }
        else {
          useText(message.message);
          brief += message.message;
        }
      }

      // 处理回复
      let source: Quotable;
      if (message.replyToMsgId || message.replyTo) {
        try {
          console.log(message.replyTo);
          const quote = message.replyToMsgId && await db.message.findFirst({
            where: {
              tgChatId: Number(pair.tg.id),
              tgMsgId: message.replyToMsgId,
              instanceId: this.instance.id,
            },
          });
          if (quote) {
            source = {
              message: message.replyTo?.quoteText || quote.brief || ' ',
              seq: quote.seq,
              rand: Number(quote.rand),
              user_id: Number(quote.qqSenderId),
              time: quote.time,
            };
          }
          else {
            source = {
              message: message.replyTo?.quoteText || '回复消息找不到',
              seq: 1,
              time: Math.floor(new Date().getTime() / 1000),
              rand: 1,
              user_id: this.oicq.uin,
            };
          }
        }
        catch (e) {
          this.log.error('查找回复消息失败', e);
          posthog.capture('查找回复消息失败', { error: e });
          source = {
            message: '查找回复消息失败',
            seq: 1,
            time: Math.floor(new Date().getTime() / 1000),
            rand: 1,
            user_id: this.oicq.uin,
          };
        }
      }

      // 防止发送空白消息
      if (chain.length === 0) {
        return [];
      }

      const notChainableElements = chain.filter(element => typeof element === 'object' && NOT_CHAINABLE_ELEMENTS.includes(element.type));
      const chainableElements = chain.filter(element => typeof element !== 'object' || !NOT_CHAINABLE_ELEMENTS.includes(element.type));

      // MapInstance
      if (!notChainableElements.length // notChainableElements 无法附加 mirai 信息，要防止被来回转发
        && chainableElements.length
        && this.instance.workMode
        && pair.instanceMapForTg[senderId]
        && !((pair.flags | this.instance.flags) & flags.DISABLE_SEAMLESS)
      ) {
        try {
          const messageSent = await pair.instanceMapForTg[senderId].sendMsg([
            ...chainableElements,
            {
              type: 'mirai',
              data: JSON.stringify({
                id: senderId,
                eqq: { type: 'tg', tgUid: senderId, noSplitSender: true, version: 2 },
                q2tgSkip: true,
              }, undefined, 0),
              // 能启用无缝模式一定是 icqq 而不是 NapCat
            } as any,
          ], source);
          tempFiles.forEach(it => it.cleanup());
          return [{
            ...messageSent,
            senderId: pair.instanceMapForTg[senderId] instanceof OicqGroup ? pair.instanceMapForTg[senderId].client.uin : 0,//TODO
            brief,
          }];
        }
        catch (e) {
          this.log.error('使用 MapInstance 发送消息失败', e);
          posthog.capture('使用 MapInstance 发送消息失败', { error: e });
        }
      }

      if (this.instance.workMode === 'group' && !isSpoilerPhoto) {
        chainableElements.unshift(messageHeader);
      }
      const qqMessages = [] as Array<QQMessageSent>;
      if (chainableElements.length) {
        if (this.oicq instanceof OicqGroup || this.oicq instanceof OicqFriend) {
          chainableElements.push({
            type: 'mirai',
            data: JSON.stringify({
              id: senderId,
              eqq: { type: 'tg', tgUid: senderId, noSplitSender: this.instance.workMode === 'personal', version: 2 },
            }, undefined, 0),
          } as any);
        }
        let messageToSend: Sendable = chainableElements;
        qqMessages.push({
          ...await pair.qq.sendMsg(messageToSend, source),
          brief,
          senderId: this.oicq.uin,
        });
      }
      if (notChainableElements.length) {
        for (const notChainableElement of notChainableElements) {
          qqMessages.push({
            ...await pair.qq.sendMsg(notChainableElement, source),
            brief,
            senderId: this.oicq.uin,
          });
        }
      }
      tempFiles.forEach(it => it.cleanup());
      return qqMessages;
    }
    catch (e) {
      this.log.error('从 TG 到 QQ 的消息转发失败', e);
      posthog.capture('从 TG 到 QQ 的消息转发失败', { error: e });
      try {
        await message.reply({
          message: `<i>转发失败：${e.message}</i>`,
          buttons: (e.message === '签名api异常' && this.restartSignCallbackHandle) ?
            Button.inline('重启签名服务', this.restartSignCallbackHandle) :
            undefined,
        });
      }
      catch {
      }
    }
  }

  public async addToZinc(pairId: number, tgMsgId: number, data: {
    text: string,
    nick: string,
  }) {
    if (!this.zincSearch) return;
    const existsReq = await fetch(env.ZINC_URL + `/api/index/q2tg-${pairId}`, {
      method: 'HEAD',
      headers: {
        Authorization: 'Basic ' + Buffer.from(env.ZINC_USERNAME + ':' + env.ZINC_PASSWORD).toString('base64'),
      },
    });
    if (existsReq.status === 404) {
      await this.zincSearch.indices.create({
        name: `q2tg-${pairId}`,
        mappings: {
          properties: {
            nick: {
              type: 'text',
              index: true,
              store: false,
              aggregatable: false,
              highlightable: true,
              analyzer: 'gse_search',
              search_analyzer: 'gse_standard',
            },
            text: {
              type: 'text',
              index: true,
              store: false,
              aggregatable: false,
              highlightable: true,
              analyzer: 'gse_search',
              search_analyzer: 'gse_standard',
            },
          },
        },
      });
    }
    await this.zincSearch.document.createOrUpdate({
      id: tgMsgId.toString(),
      index: `q2tg-${pairId}`,
      document: data,
    });
  }
}
