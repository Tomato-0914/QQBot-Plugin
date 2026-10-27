"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroupService = void 0;
class GroupService {
    constructor(request) {
        this.request = request;
    }
    /**
     * 获取群基本信息
     */
    async getInfo(groupOpenid) {
        const { data: result } = await this.request.get(`/v2/groups/${groupOpenid}/info`);
        return result;
    }
    /**
     * 获取机器人群内状态
     */
    async getBotState(groupOpenid) {
        const { data: result } = await this.request.get(`/v2/groups/${groupOpenid}/bot_state`);
        return result;
    }
    /**
     * 查询群禁言状态
     */
    async getRestrictChatSetting(groupOpenid) {
        const { data: result } = await this.request.get(`/v2/groups/${groupOpenid}/restrict_chat_setting`);
        return result;
    }
    /**
     * 设置群成员禁言，单次最多操作 10 个成员
     */
    async setMemberMuteState(groupOpenid, members) {
        const result = await this.request.post(`/v2/groups/${groupOpenid}/restrict_chat_setting`, { members });
        return result.status >= 200 && result.status < 300;
    }
    /**
     * 批量移出群成员，单次最多 20 个；可同时加入群黑名单禁止再次加群
     * 该接口内邀接入，未开通的机器人返回错误码 11253
     */
    async batchRemoveMembers(groupOpenid, memberOpenids, addToBlacklist = false) {
        const { data: result } = await this.request.post(`/v2/groups/${groupOpenid}/batch_remove_members`, {
            member_openids: memberOpenids,
            add_to_member_blacklist: addToBlacklist,
        });
        return result;
    }
}
exports.GroupService = GroupService;
