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
     * 分页获取群成员列表，每页最多 30 条；首页省略 cursor，next_cursor 为空表示末页
     * 该接口内邀接入，未开通的机器人返回错误码 11253
     */
    async getMemberList(groupOpenid, cursor) {
        const { data: result } = await this.request.get(`/v2/groups/${groupOpenid}/members`, {
            params: cursor ? { cursor } : undefined,
        });
        return result;
    }
    /**
     * 获取群成员信息
     * 该接口内邀接入，未开通的机器人返回错误码 11253
     */
    async getMemberInfo(groupOpenid, memberOpenid) {
        const { data: result } = await this.request.get(`/v2/groups/${groupOpenid}/members/${memberOpenid}`);
        return result;
    }
    /**
     * 设置群成员禁言，单次最多操作 20 个成员
     */
    async setMemberMuteState(groupOpenid, members) {
        const result = await this.request.post(`/v2/groups/${groupOpenid}/restrict_chat_setting`, { members });
        return result.status >= 200 && result.status < 300;
    }
    /**
     * 批量移出群成员，单次 1 至 20 个，不自动拆批或重试；可同时加入群黑名单禁止再次加群
     * 该接口内邀接入，未开通的机器人返回错误码 11253
     */
    async batchRemoveMembers(groupOpenid, memberOpenids, addToBlacklist = false) {
        if (typeof groupOpenid !== 'string' || !groupOpenid.trim()) {
            throw new TypeError('groupOpenid 必须是非空字符串');
        }
        if (!Array.isArray(memberOpenids) || memberOpenids.length < 1 || memberOpenids.length > 20) {
            throw new RangeError('memberOpenids 必须是包含 1 至 20 个成员 OpenID 的数组');
        }
        for (const openid of memberOpenids) {
            if (typeof openid !== 'string' || !openid.trim()) {
                throw new TypeError('成员 OpenID 必须是非空字符串');
            }
        }
        const body = { member_openids: memberOpenids };
        if (addToBlacklist === true)
            body.add_to_member_blacklist = true;
        const { data: result } = await this.request.post(`/v2/groups/${groupOpenid}/batch_remove_members`, body);
        return result;
    }
    /**
     * 分页获取入群申请列表，每页最多 50 条；首页省略 cursor，next_cursor 为空表示末页
     */
    async getJoinRequestList(groupOpenid, cursor) {
        const { data: result } = await this.request.get(`/v2/groups/${groupOpenid}/join_request_list`, {
            params: { limit: 50, ...(cursor ? { cursor } : {}) },
        });
        return result;
    }
    /**
     * 审批入群申请
     * @param op approve 同意，decline 拒绝
     */
    async approvalJoinRequest(groupOpenid, memberOpenid, { op, joinRequestId = '', rejectReason = '', addToBlacklist = false }) {
        const result = await this.request.post(`/v2/groups/${groupOpenid}/approval_join_request/${memberOpenid}`, {
            op,
            join_request_id: joinRequestId,
            reject_reason: rejectReason,
            add_to_member_blacklist: addToBlacklist,
        });
        return result.status >= 200 && result.status < 300;
    }
    /**
     * 分页获取群黑名单，每页最多 100 条；首页省略 cursor，next_cursor 为空表示末页
     */
    async getMemberBlacklist(groupOpenid, cursor) {
        const { data: result } = await this.request.get(`/v2/groups/${groupOpenid}/member_blacklist`, {
            params: { limit: 100, ...(cursor ? { cursor } : {}) },
        });
        return result;
    }
    /**
     * 加入或移出群黑名单，单次最多 20 个；返回值的 fail_openids 为操作失败的成员
     * @param op add 加入，del 移出
     */
    async changeMemberBlacklist(groupOpenid, op, memberOpenids) {
        const { data: result } = await this.request.post(`/v2/groups/${groupOpenid}/member_blacklist`, {
            op,
            member_openids: memberOpenids,
        });
        return result;
    }
}
exports.GroupService = GroupService;
