import Telegram from '../client/Telegram';
import {
  FaceElem,
  Group as OicqGroup,
  Friend as OicqFriend,
  PttElem,
  Quotable,
  segment,
} from '@icqqjs/icqq';
import { Contactable } from '@icqqjs/icqq/lib/internal';
import { fetchFile, getBigFaceUrl, getImageUrlByMd5, isContainsUrl } from '../utils/urls';
import { ButtonLike, FileLike } from 'telegram/define';
import { getLogger, Logger } from 'log4js';
import helper from '../helpers/forwardHelper';
import db from '../models/db';
import { Button } from 'telegram/tl/custom/button';
import { SendMessageParams } from 'telegram/client/messages';
import { Api } from 'telegram';
import { file as createTempFileBase, FileResult } from 'tmp-promise';
// @ts-ignore
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
import Docker from 'dockerode';
import ReplyKeyboardHide = Api.ReplyKeyboardHide;
import env from '../models/env';
import { CustomFile } from 'telegram/client/uploads';
import flags from '../constants/flags';
import BigInteger from 'big-integer';
import pastebin from '../utils/pastebin';
import { ForwardMessage, Group, MessageEvent, QQClient, Sendable, SendableElem } from '../client/QQClient';
import posthog from '../models/posthog';
import { NapCatClient } from '../client/NapCatClient';
import fsP from 'fs/promises';
import regExps from '../constants/regExps';
import qface from '../constants/qface';
import qfaceChannelMap from '../constants/qfaceChannelMap';

const NOT_CHAINABLE_ELEMENTS = ['flash', 'record', 'video', 'location', 'share', 'json', 'xml', 'poke'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/apng', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/x-icon', 'image/avif', 'image/heic', 'image/heif'];

const createTempFile = (options: Parameters<typeof createTempFileBase>[0] = {}) => createTempFileBase({
  tmpdir: env.CACHE_DIR,
  ...options,
});

type CrhPlayerInfo = {
  users: { id: number, name: string }[],
  tgMessage: Api.Message,
}

// noinspection FallThroughInSwitchStatementJS
export default class ForwardService {
  private readonly log: Logger;
  private readonly restartSignCallbackHandle?: Buffer;

  constructor(private readonly instance: Instance,
              private readonly tgBot: Telegram,
              private readonly oicq: QQClient) {
    this.log = getLogger(`ForwardService - ${instance.id}`);
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
    this.initStickerPack()
      .then(() => this.log.info('Sticker Pack 初始化完成'))
      .catch(e => {
        posthog.capture('Sticker Pack 初始化失败', { error: e });
        this.log.warn('Sticker Pack 初始化失败', e);
      });
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

  private crhPlayerInfo = new Map<Pair, CrhPlayerInfo>();

  public async forwardFromQq(event: MessageEvent, pair: Pair) {
    const tempFiles: FileResult[] = [], messageToSend: SendMessageParams = {};
    try {
      let message = '',
        files: FileLike[] = [],
        buttons: ButtonLike[] = [],
        replyTo = 0,
        forceDocument = false,
        isContainAt = false;
      let messageHeader = '', messageHeaderWithLink = '', sender = '';
      if (!event.dm) {
        // 产生头部，这和工作模式没有关系
        sender = event.from.name;
        if (event.anonymous) {
          sender = `[${sender}]${event.anonymous.name}`;
        }
        if ((pair.flags | this.instance.flags) & flags.COLOR_EMOJI_PREFIX) {
          messageHeader += emoji.color(event.from.id);
          messageHeaderWithLink += emoji.color(event.from.id);
        }
        messageHeader += `<b>${helper.htmlEscape(sender)}</b>: `;
        messageHeaderWithLink += `<b><a href="${helper.generateRichHeaderUrl(pair.apiKey, event.from.id, messageHeader)}">${helper.htmlEscape(sender)}</a></b>: `;
      }
      const useSticker = (file: FileLike) => {
        files.push(file);
        if (!event.dm) {
          if (!((pair.flags | this.instance.flags) & flags.DISABLE_RICH_HEADER) && env.WEB_ENDPOINT) {
            buttons.push(Button.url(`${sender}:`, helper.generateRichHeaderUrl(pair.apiKey, event.from.id, messageHeader)));
          }
          else {
            buttons.push(Button.inline(`${sender}:`));
          }
          messageHeader = messageHeaderWithLink = '';
        }
      };
      const useForward = async (resId: string, fileName?: string, messages?: ForwardMessage[]) => {
        if (!messages) {
          try {
            messages = await pair.qq.getForwardMsg(resId, fileName);
          }
          catch (e) {
            posthog.capture('转发多条消息（无法获取）', { error: e });
            message = '[<i>转发多条消息（无法获取）</i>]';
          }
        }
        if (messages)
          message = helper.generateForwardBrief(messages);

        if (env.WEB_ENDPOINT) {
          const dbEntry = await db.forwardMultiple.create({
            data: { resId, fileName, fromPairId: pair.dbId },
          });
          const hash = dbEntry.id;
          const viewerUrl = env.CRV_VIEWER_APP ? `${env.CRV_VIEWER_APP}?startapp=${hash}` : `${env.WEB_ENDPOINT}/ui/chatRecord?tgWebAppStartParam=${hash}`;
          buttons.push(Button.url('📃查看', viewerUrl));
        }
        else if (env.CRV_API) {
          if (!message) return;
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
        else {
          message = '[<i>转发多条消息（未配置）</i>]';
        }
      };
      const useCrhTrain = async () => {
        let existed = this.crhPlayerInfo.get(pair);
        if (!existed) {
          existed = {
            users: [],
            tgMessage: null,
          };
          this.crhPlayerInfo.set(pair, existed);
        }
        if (!existed.users.some(it => it.id === event.from.id)) {
          existed.users.push({ id: event.from.id, name: event.from.name });
        }
        const message = `<i>以下成员接了火车：</i>\n\n` + existed.users.map(it => `<b><a href="${helper.generateRichHeaderUrl(pair.apiKey, it.id)}">${it.name}</a></b>`).join('\n');

        if (existed.tgMessage) {
          try {
            existed.tgMessage = await existed.tgMessage.edit({
              text: message,
            });
          }
          catch (e) {
          }
        }
        else {
          existed.tgMessage = await pair.tg.sendMessage(message);
        }
      };
      // filter chain
      const chain = event.message
        // 我们不要这些东西
        // 对机器人的 at 和回复的 at
        // 对机器人的 at 已经在 atMe 里面处理了
        .filter(elem => !(elem.type === 'at' && elem.qq === this.oicq.uin))
        // 对回复的消息的发送者的 at 纯属多余，腾讯生成这个 at 就是脑子有毛病
        .filter(elem => !(elem.type === 'at' && elem.qq === event.replyTo?.fromId))
        // 防止出现 [/狼狗]/狼狗 这个情况，不知道后面那个 text 是怎么来的
        .filter(elem => !(elem.type === 'text' && event.message.some(it => it.type === 'face' && it.text === elem.text)))
      ;
      messageElemLoop: for (let elem of chain) {
        if (elem.type === 'flash' && (pair.flags | this.instance.flags) & flags.DISABLE_FLASH_PIC) {
          message += '<i>[闪照]</i>';
          elem = {
            ...elem,
            type: 'image',
          };
        }
        let url: string;
        switch (elem.type) {
          case 'markdown':
          case 'text': {
            let text = elem.type === 'text' ? elem.text : elem.content;
            // 判断微信文章
            const WECHAT_ARTICLE_REGEX = /https?:\/\/mp\.weixin\.qq\.com\/[0-9a-zA-Z\-_+=&?#\/]+/;
            if (WECHAT_ARTICLE_REGEX.test(text)) {
              const instantViewUrl = new URL('https://t.me/iv');
              instantViewUrl.searchParams.set('url', WECHAT_ARTICLE_REGEX.exec(text)[0]);
              instantViewUrl.searchParams.set('rhash', '45756f9b0bb3c6');
              message += `<a href="${instantViewUrl}">\u200e</a>`;
            }
            message += helper.htmlEscape(text);
            if (text === '[该接龙表情不支持查看，请使用QQ最新版本]') {
              await useCrhTrain();
              return { tgMessage: null, richHeaderUsed: false };
            }
            break;
          }
          case 'at': {
            if (!elem.text) {
              if (isNaN(elem.qq as number)) {
                elem.text = `@${elem.qq === 'all' ? '全体成员' : elem.qq}`;
              }
              else {
                const member = (pair.qq as Group).pickMember(elem.qq as number);
                const info = await member.renew();
                elem.text = `@${info.card || info.nickname}`;
              }
            }
            if (env.WEB_ENDPOINT && typeof elem.qq === 'number' && !((pair.flags | this.instance.flags) & flags.DISABLE_RICH_HEADER)) {
              message += `<a href="${helper.generateRichHeaderUrl(pair.apiKey, elem.qq)}">[<i>${helper.htmlEscape(elem.text)}</i>]</a>`;
              isContainAt = true;
              break;
            }
          }
          case 'face':
            // 判断 tgs 表情
            const tgs = this.getStickerByQQFaceId(elem.id as number);
            if (tgs && chain.length === 1) {
              useSticker(tgs);
            }
          case 'sface': {
            if (typeof elem.text !== 'string') {
              if (qface[elem.id]) {
                elem.text = qface[elem.id];
              }
              else {
                elem.text = '表情:' + elem.id;
              }
            }
            if (qfaceChannelMap[elem.id]) {
              message += `[<i><a href="https://t.me/qq_face/${qfaceChannelMap[elem.id]}">${helper.htmlEscape(elem.text)}</a></i>]`;
            }
            else {
              message += `[<i>${helper.htmlEscape(elem.text)}</i>]`;
            }
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
                else if (url.startsWith('/')) {
                  // 发完清理文件
                  tempFiles.push({
                    path: url,
                    fd: 0,
                    cleanup: () => fsP.unlink(url),
                  });
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
                  if (/^https?:\/\//.test(url)) {
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
              data: { fileId: elem.fid, roomId: pair.qqRoomId, info: message, name: elem.name },
            });
            buttons.push(Button.url('📎获取下载地址',
              `https://t.me/${this.tgBot.me.username}?start=file-${dbEntry.id}`));
            break;
          }
          case 'record': {
            url = elem.url;
            if (!url && pair.qq instanceof Contactable && elem.md5 === 'ntptt') {
              url = await pair.qq.getPttUrl(elem);
            }
            else if (!url && this.oicq instanceof OicqClient) {
              const refetchMessage = await this.oicq.oicq.getMsg(event.messageId);
              url = (refetchMessage.message.find(it => it.type === 'record') as PttElem).url;
            }
            if (url) {
              const temp = await createTempFile({ postfix: '.ogg' });
              tempFiles.push(temp);
              await silk.decode(await fetchFile(url), temp.path);
              files.push(temp.path);
            }
            else {
              // 得处理 /root/.config/QQ/nt_qq_6f9659ab3c6cc5913ddda6cc8700f48f/nt_data/Ptt/2024-07/Ori/8b0da2f31eeae8231a17cce76ebe43d2.amr 这样的路径，把 /root/.config/QQ/nt_qq_6f9659ab3c6cc5913ddda6cc8700f48f volume 出来
              // 目前思路是 docker exec 进去 cp 出来
              message += '<i>[语音]</i>';
            }
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
                await useForward(result.resId, result.fileName);
                break;
              case 'location':
                const convertedLoc = eviltransform.gcj2wgs(result.lat, result.lng);
                files.push(new Api.InputMediaVenue({
                  address: result.address,
                  title: messageHeader.replace('<b>', '').replace('</b>', ''),
                  geoPoint: new Api.InputGeoPoint({
                    lat: convertedLoc.lat,
                    long: convertedLoc.lng,
                  }),
                  provider: 'Q2TG',
                  venueId: 'Q2TG',
                  venueType: 'Q2TG',
                }));
                // 电脑 tg 不会显示地图的 caption
                messageHeader = messageHeaderWithLink = '';
                // 这里用火星坐标
                message = `<a href="https://uri.amap.com/marker?position=${result.lng},${result.lat}">在高德地图中查看</a>`;
                break;
            }
            break messageElemLoop;
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
            break messageElemLoop;
          }
          case 'rps':
          case 'dice':
            message = `[<i>${elem.type === 'rps' ? '猜拳' : '骰子'}</i>] ${elem.id}`;
            break;
          case 'poke':
            message = `[<i>戳一戳</i>] ${helper.htmlEscape(elem.text)}`;
            break;
          case 'forward':
            await useForward(elem.id, '', elem.content);
            break;
        }
      }
      this.crhPlayerInfo.delete(pair);
      message = message.trim();
      if (!event.message.length) {
        message += '<i>[消息无法解析出内容]</i>';
      }

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
      if (((pair.flags | this.instance.flags) & flags.DISABLE_RICH_HEADER) || !env.WEB_ENDPOINT) {
        messageHeaderWithLink = messageHeader;
      }
      // 发送消息
      messageToSend.forceDocument = forceDocument as any; // 恼
      messageToSend.linkPreview = false;
      if (files.length === 1) {
        messageToSend.file = files[0];
      }
      else if (files.length) {
        messageToSend.file = files;
      }
      else if (!event.dm && !((pair.flags | this.instance.flags) & flags.DISABLE_RICH_HEADER) && env.WEB_ENDPOINT
        // 当消息包含链接时不显示 RICH HEADER
        && (isContainAt || !isContainsUrl(message))) {
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
      else if (!isContainAt && isContainsUrl(message)) {
        // 手动找出需要 preview 的 url，防止 preview richHeader 的 url
        const urls = message.match(regExps.url);
        if (urls?.length) {
          const url = urls[0];
          messageToSend.file = new Api.InputMediaWebPage({
            url,
            forceSmallMedia: true,
            optional: true,
          });
          messageToSend.linkPreview = { showAboveText: false };
        }
      }

      if (!richHeaderUsed) {
        message = messageHeaderWithLink + (message && messageHeaderWithLink ? '\n' : '') + message;
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
          // 这里可能是因为 url 本身不合法之类的问题，所以这里发送不带链接的 header
          message = messageHeader + (message && messageHeader ? '\n' : '') + message;
          message && (messageToSend.message = message);
          tgMessage = await pair.tg.sendMessage(messageToSend);
        }
        else if (messageToSend.file instanceof Api.InputMediaWebPage) {
          delete messageToSend.file;
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
          if (['WebPage', 'WebPageNotModified'].includes((userMessage?.media as Api.MessageMediaWebPage)?.webpage?.className))
            return;
          // 没有正常获取的话，就加上原先的头部
          this.log.warn('Rich Header 回测错误', messageToSend.file);
          await tgMessage.edit({
            text: messageHeaderWithLink + (message && messageHeaderWithLink ? '\n' : '') + message,
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
      let error = e;
      if (JSON.stringify(error) === '{}') {
        error = {
          message: e.message,
          stack: e.stack,
          str: e.toString(),
        };
      }
      try {
        pbUrl = await pastebin.upload(JSON.stringify({
          error,
          event,
          messageToSend,
        }));
        pbUrl += '.json';
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
      const senderId = Number(message.senderId || message.sender?.id) || pair.tgId;
      this.log.debug('senderId', senderId);
      // 这条消息在 tg 中被回复的时候显示的
      let brief = '', isSpoilerPhoto = false;
      let userDisplayName = helper.getUserDisplayName(message.sender);
      if (senderId === pair.tgId && !message.sender) {
        userDisplayName = helper.getUserDisplayName(message.chat);
      }
      let messageHeader = userDisplayName +
        (message.forward ? ' 转发自 ' +
          // 要是隐私设置了，应该会有这个，然后下面两个都获取不到
          (message.fwdFrom?.fromName ||
            helper.getUserDisplayName(await message.forward.getChat() || await message.forward.getSender())) :
          '');
      messageHeader += ': \n';
      if ((pair.flags | this.instance.flags) & flags.COLOR_EMOJI_PREFIX) {
        let emoji1 = emoji.tgColor((message.sender as Api.User)?.color?.color || senderId);
        if (message.sender instanceof Api.Channel && message.sender.broadcast) {
          emoji1 = '📢' + emoji1;
        }
        else if (message.sender instanceof Api.Chat || message.sender instanceof Api.Channel || !message.senderId) {
          emoji1 = '👻' + emoji1;
        }
        messageHeader = emoji1 + messageHeader;
      }

      this.crhPlayerInfo.delete(pair);

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
}
