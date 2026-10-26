/* HowGo 管理台 — LaswI Studio (c) 2026 */
'use strict';

(function () {
  const H = window.HowGo;
  const { api, el, clear, toast, fmtTime, state } = H;

  let currentTab = 'overview';
  let busy = false;

  const STATUS_LABEL = {
    ok: '正常',
    masked: '已打码',
    blocked: '已拦截',
    deleted: '已删除'
  };

  const ACTION_LABEL = {
    'message-blocked': '消息被拦截',
    'message-masked': '消息被打码',
    'message-delete': '管理员删除消息',
    report: '用户举报',
    'report-resolve': '处理举报',
    'user-ban': '封禁用户',
    'user-unban': '解除封禁',
    'word-add': '新增敏感词',
    'word-remove': '移除敏感词'
  };

  /* ---------------- 渲染入口 ---------------- */

  async function render(container, tab) {
    currentTab = tab || currentTab;
    document.querySelectorAll('.admin-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.admin === currentTab);
    });
    if (busy) return;
    busy = true;
    try {
      clear(container);
      container.appendChild(el('div', { class: 'empty-small', text: '加载中…' }));
      const nodes = await build(currentTab);
      clear(container);
      nodes.forEach((n) => container.appendChild(n));
    } catch (e) {
      clear(container);
      if (e.status === 401 || e.status === 403) {
        container.appendChild(el('div', { class: 'card' }, el('h3', { text: '权限不足' }), el('p', { class: 'row-sub', text: '当前账号不是管理员，或管理会话已过期，请重新登录。' })));
      } else {
        container.appendChild(el('div', { class: 'card' }, el('h3', { text: '加载失败' }), el('p', { class: 'row-sub', text: e.message })));
      }
    } finally {
      busy = false;
    }
  }

  function build(tab) {
    switch (tab) {
      case 'messages':
        return buildMessages();
      case 'reports':
        return buildReports();
      case 'users':
        return buildUsers();
      case 'words':
        return buildWords();
      case 'audits':
        return buildAudits();
      default:
        return buildOverview();
    }
  }

  /* ---------------- 概览 ---------------- */

  async function buildOverview() {
    const o = await api('/api/admin/overview');
    const grid = el('div', { class: 'stat-grid' });
    const cards = [
      ['注册用户', o.users, ''],
      ['被封禁用户', o.bannedUsers, o.bannedUsers ? 'warn' : ''],
      ['消息总数', o.messages, ''],
      ['今日拦截', o.blockedToday, o.blockedToday ? 'warn' : ''],
      ['累计打码', o.maskedTotal, ''],
      ['已删除消息', o.deletedTotal, ''],
      ['待处理举报', o.openReports, o.openReports ? 'warn' : '']
    ];
    cards.forEach(([label, value, cls]) => {
      grid.appendChild(
        el('div', { class: 'stat-card ' + cls }, el('span', { text: label }), el('b', { text: value }))
      );
    });

    const guard = el(
      'div',
      { class: 'card' },
      el('h3', { text: '内容治理闸口' }),
      el(
        'div',
        { class: 'row-sub' },
        el('div', { text: '1. 发送前服务端扫描：命中禁用词直接拦截（451），命中引流词自动打码后发送。' }),
        el('div', { text: '2. 新账号 24 小时内禁止发送链接与外链二维码文本。' }),
        el('div', { text: '3. 同一账号 60 秒内重复相同内容 2 次即判定刷屏并拒绝。' }),
        el('div', { text: '4. 每分钟发送上限 20 条，超出返回 429。' }),
        el('div', { text: '5. 举报进入队列，管理员删除后会话内自动留下系统提示，全过程写入审计日志。' })
      )
    );

    await appendRecentAudits(guard);
    return [el('div', { class: 'card' }, el('h3', { text: '数据概览' }), grid), guard];
  }

  async function appendRecentAudits(card) {
    try {
      const r = await api('/api/admin/audits');
      const rows = r.audits.slice(0, 6);
      card.appendChild(el('h3', { text: '最近操作', attrs: { style: 'margin-top:16px' } }));
      if (!rows.length) {
        card.appendChild(el('div', { class: 'row-sub', text: '暂无记录' }));
        return;
      }
      rows.forEach((a) => card.appendChild(auditRow(a)));
    } catch {
      /* 忽略 */
    }
  }

  function auditRow(a) {
    return el(
      'div',
      { class: 'row' },
      el(
        'div',
        { class: 'row-main' },
        el('div', { class: 'row-text' }, el('strong', { text: a.actorName + ' ' }), ACTION_LABEL[a.action] || a.action),
        el('div', { class: 'row-sub', text: fmtTime(a.at) + (a.target ? ' · ' + a.target : '') + (a.detail ? ' · ' + a.detail : '') })
      )
    );
  }

  /* ---------------- 消息审查 ---------------- */

  async function buildMessages() {
    const wrap = el('div', {});
    const filter = el('select', {}, ...['', 'ok', 'masked', 'blocked', 'deleted'].map((v) =>
      el('option', { text: v ? STATUS_LABEL[v] : '全部状态', attrs: { value: v } })
    ));
    const qInput = el('input', { class: 'grow', attrs: { placeholder: '搜索消息内容…' } });
    const listBox = el('div', { class: 'card' });

    const load = async () => {
      clear(listBox);
      listBox.appendChild(el('div', { class: 'row-sub', text: '加载中…' }));
      const qs = [];
      if (filter.value) qs.push('status=' + encodeURIComponent(filter.value));
      if (qInput.value.trim()) qs.push('q=' + encodeURIComponent(qInput.value.trim()));
      const r = await api('/api/admin/messages' + (qs.length ? '?' + qs.join('&') : ''));
      clear(listBox);
      if (!r.messages.length) {
        listBox.appendChild(el('div', { class: 'empty-small', text: '没有符合条件的消息' }));
        return;
      }
      r.messages.forEach((m) => listBox.appendChild(messageRow(m, load)));
    };

    filter.addEventListener('change', () => load().catch((e) => toast(e.message, true)));
    qInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') load().catch((err) => toast(err.message, true));
    });

    wrap.appendChild(
      el(
        'div',
        { class: 'card' },
        el('h3', { text: '消息审查' }),
        el('div', { class: 'inline-form' }, filter, qInput, el('button', { class: 'btn-mini primary', text: '查询', on: { click: () => load().catch((e) => toast(e.message, true)) } })),
        el('div', { class: 'row-sub', text: '被拦截的内容默认不送达对方，仅在此处对管理员可见，可用于取证。' })
      )
    );
    wrap.appendChild(listBox);
    await load();
    return [wrap];
  }

  function messageRow(m, reload) {
    const statusCls = m.status === 'blocked' ? 'blocked' : m.status === 'masked' ? 'masked' : m.status === 'deleted' ? 'deleted' : 'ok';
    const actions = el('div', { class: 'row-actions' });
    if (m.status !== 'deleted') {
      actions.appendChild(
        el('button', {
          class: 'btn-mini danger',
          text: '删除',
          on: {
            click: async () => {
              const reason = prompt('删除理由（会作为系统提示展示给会话双方）', '违反《HowGo 社区规范》');
              if (reason === null) return;
              try {
                await api('/api/admin/messages/' + m.id + '/delete', { method: 'POST', body: { reason } });
                toast('已删除并通知双方');
                await reload();
              } catch (e) {
                toast(e.message, true);
              }
            }
          }
        })
      );
    }
    if (m.from && m.from.id) {
      actions.appendChild(
        el('button', {
          class: 'btn-mini',
          text: '封禁发送者',
          on: {
            click: async () => {
              const minutes = Number(prompt('封禁时长（分钟）', '60'));
              if (!minutes || Number.isNaN(minutes)) return;
              try {
                await api('/api/admin/users/' + m.from.id + '/ban', { method: 'POST', body: { minutes } });
                toast('已封禁 ' + m.from.name);
                await reload();
              } catch (e) {
                toast(e.message, true);
              }
            }
          }
        })
      );
    }

    return el(
      'div',
      { class: 'row' },
      el(
        'div',
        { class: 'row-main' },
        el(
          'div',
          { class: 'row-text' },
          el('span', { class: 'pill ' + statusCls, text: STATUS_LABEL[m.status] || m.status }),
          ' ',
          el('strong', { text: (m.from ? m.from.name : '?') + (m.to ? ' → ' + m.to.name : '') }),
          '：',
          m.text || '（内容不可见）'
        ),
        el('div', {
          class: 'row-sub',
          text:
            fmtTime(m.at) +
            (m.flags && m.flags.length ? ' · 命中：' + m.flags.join('、') : '') +
            (m.blockedReason ? ' · 拦截理由：' + m.blockedReason : '') +
            (m.reported ? ' · 已被举报' : '')
        })
      ),
      actions
    );
  }

  /* ---------------- 举报 ---------------- */

  async function buildReports() {
    const r = await api('/api/admin/reports');
    const card = el('div', { class: 'card' }, el('h3', { text: '举报队列' }));

    if (!r.reports.length) {
      card.appendChild(el('div', { class: 'empty-small', text: '暂无举报' }));
      return [card];
    }

    const reload = () => render(document.querySelector('#admin-body'), 'reports');

    r.reports.forEach((rep) => {
      const actions = el('div', { class: 'row-actions' });
      if (rep.status === 'open') {
        actions.appendChild(
          el('button', {
            class: 'btn-mini danger',
            text: '判定违规并删除',
            on: {
              click: async () => {
                try {
                  await api('/api/admin/reports/' + rep.id + '/resolve', { method: 'POST', body: { action: 'delete' } });
                  toast('已删除违规消息');
                  await reload();
                } catch (e) {
                  toast(e.message, true);
                }
              }
            }
          })
        );
        actions.appendChild(
          el('button', {
            class: 'btn-mini',
            text: '驳回举报',
            on: {
              click: async () => {
                try {
                  await api('/api/admin/reports/' + rep.id + '/resolve', { method: 'POST', body: { action: 'keep' } });
                  toast('已驳回');
                  await reload();
                } catch (e) {
                  toast(e.message, true);
                }
              }
            }
          })
        );
      }

      card.appendChild(
        el(
          'div',
          { class: 'row' },
          el(
            'div',
            { class: 'row-main' },
            el(
              'div',
              { class: 'row-text' },
              el('span', { class: 'pill ' + (rep.status === 'open' ? 'open' : 'resolved'), text: rep.status === 'open' ? '待处理' : '已处理' }),
              ' ',
              rep.message ? rep.message.from + '：' + (rep.message.text || '（已被删除）') : '（原消息已不存在）'
            ),
            el('div', { class: 'row-sub', text: fmtTime(rep.at) + ' · 举报人 ' + rep.reporter + ' · 理由：' + rep.reason })
          ),
          actions
        )
      );
    });

    return [card];
  }

  /* ---------------- 用户 ---------------- */

  async function buildUsers() {
    const r = await api('/api/admin/users');
    const card = el('div', { class: 'card' }, el('h3', { text: '用户管理' }));
    const reload = () => render(document.querySelector('#admin-body'), 'users');

    if (!r.users.length) {
      card.appendChild(el('div', { class: 'empty-small', text: '暂无普通用户' }));
      return [card];
    }

    r.users.forEach((u) => {
      const actions = el('div', { class: 'row-actions' });
      if (u.banned) {
        actions.appendChild(
          el('button', {
            class: 'btn-mini',
            text: '解除',
            on: {
              click: async () => {
                try {
                  await api('/api/admin/users/' + u.id + '/unban', { method: 'POST' });
                  toast('已解除限制');
                  await reload();
                } catch (e) {
                  toast(e.message, true);
                }
              }
            }
          })
        );
      } else {
        actions.appendChild(
          el('button', {
            class: 'btn-mini danger',
            text: '限制发言',
            on: {
              click: async () => {
                const minutes = Number(prompt('限制时长（分钟）', '60'));
                if (!minutes || Number.isNaN(minutes)) return;
                const reason = prompt('理由', '违反《HowGo 社区规范》') || '违反《HowGo 社区规范》';
                try {
                  await api('/api/admin/users/' + u.id + '/ban', { method: 'POST', body: { minutes, reason } });
                  toast('已限制 ' + u.name);
                  await reload();
                } catch (e) {
                  toast(e.message, true);
                }
              }
            }
          })
        );
      }

      card.appendChild(
        el(
          'div',
          { class: 'row' },
          el('div', { class: 'avatar', text: (u.name || '?').slice(0, 1) }),
          el(
            'div',
            { class: 'row-main' },
            el(
              'div',
              { class: 'row-text' },
              el('strong', { text: u.name }),
              el('span', { class: 'row-sub', text: ' · 号 ' + u.id }),
              ' ',
              u.banned ? el('span', { class: 'pill ban', text: '已限制' }) : el('span', { class: 'pill ok', text: '正常' })
            ),
            el('div', {
              class: 'row-sub',
              text:
                '发送 ' + u.sent + ' 条 · 被拦截 ' + u.blocked + ' 次' +
                (u.bannedUntil ? ' · 至 ' + fmtTime(u.bannedUntil) + ' · ' + (u.bannedReason || '') : '')
            })
          ),
          actions
        )
      );
    });

    return [card];
  }

  /* ---------------- 敏感词库 ---------------- */

  async function buildWords() {
    const r = await api('/api/admin/words');
    const wrap = el('div', {});

    const makeSection = (kind, title, desc) => {
      const card = el('div', { class: 'card' }, el('h3', { text: title }), el('div', { class: 'row-sub', text: desc }));
      const input = el('input', { class: 'grow', attrs: { placeholder: '输入词条后回车添加' } });
      const add = async () => {
        const word = input.value.trim();
        if (!word) return;
        try {
          await api('/api/admin/words', { method: 'POST', body: { kind, word } });
          input.value = '';
          toast('已添加');
          render(document.querySelector('#admin-body'), 'words');
        } catch (e) {
          toast(e.message, true);
        }
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') add();
      });
      card.appendChild(
        el('div', { class: 'inline-form' }, input, el('button', { class: 'btn-mini primary', text: '添加', on: { click: add } }))
      );

      const chips = el('div', {});
      const words = r.words[kind] || [];
      if (!words.length) {
        chips.appendChild(el('div', { class: 'empty-small', text: '词库为空' }));
      }
      words.forEach((w) => {
        chips.appendChild(
          el(
            'span',
            { class: 'word-chip' },
            w,
            el('button', {
              text: '×',
              on: {
                click: async () => {
                  try {
                    await api('/api/admin/words/remove', { method: 'POST', body: { kind, word: w } });
                    toast('已移除');
                    render(document.querySelector('#admin-body'), 'words');
                  } catch (e) {
                    toast(e.message, true);
                  }
                }
              }
            })
          )
        );
      });
      card.appendChild(chips);
      return card;
    };

    wrap.appendChild(makeSection('block', '拦截词库', '命中即拒绝发送，不写入会话，仅管理员可见。'));
    wrap.appendChild(makeSection('mask', '打码词库', '命中后自动遮蔽关键词（手机号、社交账号、外链等），消息仍可送达。'));
    return [wrap];
  }

  /* ---------------- 审计日志 ---------------- */

  async function buildAudits() {
    const r = await api('/api/admin/audits');
    const card = el('div', { class: 'card' }, el('h3', { text: '审计日志（最近 200 条）' }));
    if (!r.audits.length) {
      card.appendChild(el('div', { class: 'empty-small', text: '暂无记录' }));
      return [card];
    }
    r.audits.forEach((a) => card.appendChild(auditRow(a)));
    return [card];
  }

  /* ---------------- 绑定导航 ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.admin-tab').forEach((b) => {
      b.addEventListener('click', () => {
        currentTab = b.dataset.admin;
        render(document.querySelector('#admin-body'), currentTab);
      });
    });
  });

  window.HowGoAdmin = {
    render,
    refresh() {
      if (state.panel !== 'admin') return;
      const box = document.querySelector('#admin-body');
      if (box) render(box, currentTab);
    }
  };
})();
