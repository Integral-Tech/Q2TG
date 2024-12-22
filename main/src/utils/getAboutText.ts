import { Group as OicqGroup } from '@icqqjs/icqq';
import { Friend, Group, GroupMemberInfo } from '../client/QQClient';
import { NapCatGroup } from '../client/NapCatClient';

export default async function getAboutText(entity: Friend | Group, html: boolean) {
  let text: string;
  if ('uin' in entity) {
    text = `<b>备注：</b>${entity.remark}\n` +
      `<b>昵称：</b>${entity.nickname}\n` +
      `<b>账号：</b>${entity.uin}`;
  }
  else {
    let owner: GroupMemberInfo;
    let memberCount: number;
    if (entity instanceof OicqGroup) {
      owner = await entity.pickMember(entity.info.owner_id).renew();
      memberCount = entity.info.member_count;
    }
    else if (entity instanceof NapCatGroup) {
      const membersInfo = await entity.getAllMemberInfo();
      owner = membersInfo.find(member => member.role === 'owner');
      memberCount = membersInfo.length;
    }
    const self = await entity.pickMember(entity.client.uin).renew();
    text = `<b>群名称：</b>${entity.name}\n` +
      `<b>${memberCount} 名成员</b>\n` +
      `<b>群号：</b><code>${entity.gid}</code>\n` +
      (self ? `<b>我的群名片：</b>${self.title ? `「<i>${self.title}</i>」` : ''}${self.card}\n` : '') +
      (owner ? `<b>群主：</b>${owner.title ? `「<i>${owner.title}</i>」` : ''}` +
        `${owner.card || owner.nickname} (<code>${owner.user_id}</code>)` : '') +
      ((entity.is_admin || entity.is_owner) ? '\n<b>可管理</b>' : '');
  }

  if (!html) {
    text = text.replace(/<\/?\w+>/g, '');
  }
  return text;
}
