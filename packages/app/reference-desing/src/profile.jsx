// User profile — vaults + agents + api keys

const Profile = ({ user, onNavigate, onBindFlow, bindMcp, onClearBind }) => {
  const [tab, setTab] = React.useState(bindMcp ? 'agents' : 'overview');
  const [creatingVault, setCreatingVault] = React.useState(false);
  const [creatingAgent, setCreatingAgent] = React.useState(!!bindMcp);
  const [vaults, setVaults] = React.useState(USER_VAULTS);
  const [agents, setAgents] = React.useState(USER_AGENTS);

  const tabs = [
    { id: 'overview', l: 'Overview' },
    { id: 'vaults', l: 'Vaults & Keys' },
    { id: 'agents', l: 'Agents' },
    { id: 'activity', l: 'Activity' },
    { id: 'settings', l: 'Settings' },
  ];

  return (
    <main style={{ padding: '40px 32px 80px' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto' }}>
        {/* profile header */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 24, alignItems: 'center',
          padding: 24, background: 'var(--ink)', color: 'var(--parchment)',
          boxShadow: '5px 5px 0 var(--brass)',
        }}>
          <div style={{
            width: 80, height: 80, background: 'var(--brass)',
            display: 'grid', placeItems: 'center', color: 'var(--ink)',
            border: '3px solid var(--brass-bright)',
          }}>
            <OrlojMark size={64} />
          </div>
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="display" style={{ fontSize: 28 }}>{user.name}</div>
              <Pill tone="brass" style={{ background: 'rgba(184,137,58,0.25)', color: 'var(--brass-bright)', borderColor: 'var(--brass)' }}>
                {user.plan}
              </Pill>
            </div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--brass-bright)', marginTop: 4 }}>{user.address} · joined {user.joined}</div>
            <div style={{ display: 'flex', gap: 24, marginTop: 14, fontSize: 13, color: 'rgba(241,233,212,0.7)' }}>
              <span>{vaults.length} vaults</span>
              <span>·</span>
              <span>{agents.length} agents</span>
              <span>·</span>
              <span>{agents.reduce((a, b) => a + b.runs, 0)} tool calls this month</span>
            </div>
          </div>
          <Btn kind="brass" onClick={() => onNavigate('register')}>+ Publish MCP</Btn>
        </div>

        {/* tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--line)', marginTop: 24 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} className="smallcaps" style={{
              padding: '14px 22px', background: 'transparent', border: 'none', cursor: 'pointer',
              fontSize: 12, fontFamily: 'var(--font-ui)',
              color: tab === t.id ? 'var(--ink)' : 'var(--ink-soft)',
              borderBottom: `2px solid ${tab === t.id ? 'var(--brass)' : 'transparent'}`,
              fontWeight: tab === t.id ? 600 : 400,
            }}>{t.l}</button>
          ))}
        </div>

        {/* binding banner */}
        {bindMcp && tab === 'agents' && (
          <div style={{ marginTop: 18, padding: 16, background: 'rgba(184,137,58,0.18)', border: '1.5px solid var(--brass)', display: 'flex', gap: 14, alignItems: 'center' }}>
            <span style={{ fontSize: 22, color: 'var(--brass-deep)' }}>🔗</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Binding "{bindMcp.name}" to a new agent…</div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 2 }}>Select a vault below or close to bind to an existing agent.</div>
            </div>
            <Btn size="sm" kind="ghost" onClick={onClearBind}>Cancel binding</Btn>
          </div>
        )}

        <div style={{ marginTop: 24 }}>
          {tab === 'overview' && <Overview user={user} vaults={vaults} agents={agents} setTab={setTab} onNavigate={onNavigate} />}
          {tab === 'vaults' && <Vaults vaults={vaults} setVaults={setVaults} creating={creatingVault} setCreating={setCreatingVault} />}
          {tab === 'agents' && <Agents agents={agents} setAgents={setAgents} vaults={vaults} creating={creatingAgent} setCreating={setCreatingAgent} bindMcp={bindMcp} onClearBind={onClearBind} />}
          {tab === 'activity' && <Activity agents={agents} />}
          {tab === 'settings' && <Settings user={user} />}
        </div>
      </div>
    </main>
  );
};

const Overview = ({ user, vaults, agents, setTab, onNavigate }) => (
  <div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
      {[
        { l: 'tool calls / month', v: '1,047', d: '+18% vs prior', tone: 'verdigris' },
        { l: 'active vaults', v: vaults.length, d: 'all under policy', tone: 'brass' },
        { l: 'agents online', v: agents.filter(a => a.status === 'active').length, d: `${agents.length} total`, tone: 'blue' },
        { l: 'mcps bound', v: '7', d: 'across 4 chains', tone: 'wine' },
      ].map((s, i) => {
        const accent = s.tone === 'verdigris' ? 'var(--verdigris)' : s.tone === 'brass' ? 'var(--brass)' : s.tone === 'blue' ? 'var(--stained-blue)' : 'var(--wine)';
        return (
          <div key={i} style={{
            padding: 20, background: 'rgba(241,233,212,0.5)', border: '1px solid var(--line)',
            borderTop: `3px solid ${accent}`,
          }}>
            <div className="smallcaps" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{s.l}</div>
            <div className="display" style={{ fontSize: 36, color: 'var(--ink)', marginTop: 4, lineHeight: 1 }}>{s.v}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 6 }}>{s.d}</div>
          </div>
        );
      })}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24, marginTop: 28 }}>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 className="display" style={{ fontSize: 20, margin: 0 }}>Recent activity</h3>
          <button onClick={() => setTab('activity')} className="smallcaps" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--brass-deep)', fontFamily: 'var(--font-ui)' }}>view all →</button>
        </div>
        <ActivityFeed compact agents={USER_AGENTS} />
      </div>
      <div>
        <h3 className="display" style={{ fontSize: 20, margin: 0 }}>Suggested MCPs</h3>
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          {MCP_REGISTRY.slice(0, 3).map(m => (
            <div key={m.id} onClick={() => onNavigate('explore')} style={{
              padding: 12, display: 'flex', gap: 10, alignItems: 'center',
              background: 'rgba(241,233,212,0.5)', border: '1px solid var(--line)', cursor: 'pointer',
            }}>
              <Identicon seed={m.id} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-soft)' }}>{m.tags.slice(0, 2).join(' · ')}</div>
              </div>
              <span style={{ color: 'var(--brass-deep)' }}>→</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

const Vaults = ({ vaults, setVaults, creating, setCreating }) => {
  const [revealed, setRevealed] = React.useState({});
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
        <div>
          <h2 className="display" style={{ fontSize: 28, margin: 0 }}>Vaults & private keys</h2>
          <p className="poetic" style={{ fontSize: 17, color: 'var(--ink-soft)', marginTop: 4, marginBottom: 0 }}>Custody routed through KMS providers. Keys never leave the enclave.</p>
        </div>
        <Btn kind="primary" onClick={() => setCreating(true)}>+ Create vault</Btn>
      </div>

      {creating && <CreateVault onCancel={() => setCreating(false)} onCreate={(v) => { setVaults([...vaults, { ...v, id: 'v-' + Date.now() }]); setCreating(false); }} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 18 }}>
        {vaults.map(v => {
          const accent = v.color === 'verdigris' ? 'var(--verdigris)' : v.color === 'brass' ? 'var(--brass)' : 'var(--stained-blue)';
          return (
            <div key={v.id} style={{
              position: 'relative', padding: 20, background: 'rgba(241,233,212,0.55)',
              border: '1px solid var(--line)', borderLeft: `4px solid ${accent}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div className="display" style={{ fontSize: 18 }}>{v.label}</div>
                  <div className="smallcaps" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 2 }}>kms · {v.kms}</div>
                </div>
                <Pill tone="verdigris">● secured</Pill>
              </div>
              <div style={{ marginTop: 14, padding: 10, background: 'var(--ink)', color: 'var(--brass-bright)' }}>
                <div className="smallcaps" style={{ fontSize: 9, color: 'rgba(241,233,212,0.5)' }}>address</div>
                <div className="mono" style={{ fontSize: 12 }}>{v.address}</div>
              </div>
              <div style={{ marginTop: 12, padding: 10, background: 'rgba(255,255,255,0.4)', border: '1px solid var(--line)' }}>
                <div className="smallcaps" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>private key</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--ink)', letterSpacing: '0.04em' }}>
                    {revealed[v.id] ? '0x4f3a2c...e1d8b9 (last 6 of 64)' : '•••• •••• •••• •••• •••• •••• ••••'}
                  </div>
                  <button onClick={() => setRevealed(r => ({ ...r, [v.id]: !r[v.id] }))} className="smallcaps" style={{
                    background: 'none', border: 'none', cursor: 'pointer', fontSize: 10,
                    color: 'var(--brass-deep)', fontFamily: 'var(--font-ui)',
                  }}>{revealed[v.id] ? 'hide' : 'reveal'}</button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 14 }}>
                <KV l="policy" v={v.policy} />
                <KV l="keys" v={v.keys} />
                <KV l="last used" v={v.lastUsed} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <Btn size="sm" kind="ghost">Edit policy</Btn>
                <Btn size="sm" kind="ghost">Rotate</Btn>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const KV = ({ l, v }) => (
  <div>
    <div className="smallcaps" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>{l}</div>
    <div style={{ fontSize: 12, color: 'var(--ink)', marginTop: 2 }}>{v}</div>
  </div>
);

const CreateVault = ({ onCancel, onCreate }) => {
  const [label, setLabel] = React.useState('');
  const [kms, setKms] = React.useState('Turnkey');
  const [policy, setPolicy] = React.useState('100 USDC / day');
  const [color, setColor] = React.useState('brass');
  return (
    <div style={{ padding: 24, marginBottom: 20, background: 'var(--parchment-2)', border: '2px solid var(--brass)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 18 }}>
        <GearIcon size={20} />
        <h3 className="display" style={{ fontSize: 18, margin: 0 }}>New vault</h3>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
        <Field label="Label">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Daily Operations" />
        </Field>
        <Field label="KMS provider">
          <Select value={kms} onChange={setKms} options={['Turnkey', 'Fireblocks', 'Lit Protocol', 'Privy', 'Self-custody (Safe)']} />
        </Field>
        <Field label="Spend policy">
          <Input value={policy} onChange={(e) => setPolicy(e.target.value)} />
        </Field>
      </div>
      <Field label="Vault color" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          {[['brass', 'var(--brass)'], ['verdigris', 'var(--verdigris)'], ['blue', 'var(--stained-blue)'], ['wine', 'var(--wine)']].map(([k, c]) => (
            <button key={k} onClick={() => setColor(k)} style={{
              width: 36, height: 36, background: c, border: color === k ? '2px solid var(--ink)' : '2px solid transparent',
              cursor: 'pointer', boxShadow: color === k ? '2px 2px 0 var(--ink-soft)' : 'none',
            }} />
          ))}
        </div>
      </Field>
      <div style={{ display: 'flex', gap: 12, marginTop: 22, justifyContent: 'flex-end' }}>
        <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>
        <Btn kind="primary" disabled={!label} onClick={() => onCreate({ label, kms, policy, color, address: '0x' + Math.random().toString(16).slice(2, 10) + '...' + Math.random().toString(16).slice(2, 6), keys: 1, lastUsed: 'just now' })}>Generate keypair</Btn>
      </div>
    </div>
  );
};

const Agents = ({ agents, setAgents, vaults, creating, setCreating, bindMcp, onClearBind }) => (
  <div>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 18 }}>
      <div>
        <h2 className="display" style={{ fontSize: 28, margin: 0 }}>Agents</h2>
        <p className="poetic" style={{ fontSize: 17, color: 'var(--ink-soft)', marginTop: 4, marginBottom: 0 }}>Each agent rings a different bell. Bind MCPs and set them off.</p>
      </div>
      <Btn kind="primary" onClick={() => setCreating(true)}>+ Register agent</Btn>
    </div>

    {creating && <CreateAgent vaults={vaults} bindMcp={bindMcp} onCancel={() => { setCreating(false); onClearBind && onClearBind(); }} onCreate={(a) => { setAgents([{ ...a, id: 'a-' + Date.now() }, ...agents]); setCreating(false); onClearBind && onClearBind(); }} />}

    <div style={{ display: 'grid', gap: 14 }}>
      {agents.map(a => (
        <div key={a.id} style={{
          padding: 18, background: 'rgba(241,233,212,0.55)', border: '1px solid var(--line)',
          display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 18, alignItems: 'center',
        }}>
          <div style={{ width: 56, height: 56, background: 'var(--ink)', display: 'grid', placeItems: 'center', border: '2px solid var(--brass)' }}>
            <GearIcon size={32} color="var(--brass-bright)" spinning={a.status === 'active'} />
          </div>
          <div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div className="display" style={{ fontSize: 18 }}>{a.name}</div>
              <Pill tone={a.status === 'active' ? 'verdigris' : a.status === 'paused' ? 'ink' : 'wine'}>
                {a.status === 'active' ? '● active' : a.status === 'paused' ? '⏸ paused' : '⚠ review'}
              </Pill>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 4 }}>
              vault: <span style={{ color: 'var(--ink)' }}>{a.vault}</span>
              <span style={{ margin: '0 8px' }}>·</span>
              {a.mcps.length} MCPs bound
              <span style={{ margin: '0 8px' }}>·</span>
              {a.runs} runs · last {a.lastRun}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {a.mcps.map(m => <Tag key={m}>⌘ {m}</Tag>)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="display" style={{ fontSize: 22, color: 'var(--brass-deep)' }}>{a.runs}</div>
            <div className="smallcaps" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>runs</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn size="sm" kind="ghost">Logs</Btn>
            <Btn size="sm" kind="primary">{a.status === 'active' ? 'Pause' : 'Resume'}</Btn>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const CreateAgent = ({ vaults, bindMcp, onCancel, onCreate }) => {
  const [name, setName] = React.useState('');
  const [vault, setVault] = React.useState(vaults[0]?.label || '');
  const [model, setModel] = React.useState('Claude Sonnet 4.5');
  return (
    <div style={{ padding: 24, marginBottom: 20, background: 'var(--parchment-2)', border: '2px solid var(--brass)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 18 }}>
        <GearIcon size={20} />
        <h3 className="display" style={{ fontSize: 18, margin: 0 }}>
          {bindMcp ? `Bind "${bindMcp.name}" to a new agent` : 'New agent'}
        </h3>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
        <Field label="Agent name" hint="A name your team will recognize.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Karel — Yield Steward" />
        </Field>
        <Field label="Operating vault">
          <Select value={vault} onChange={setVault} options={vaults.map(v => v.label)} />
        </Field>
        <Field label="Model">
          <Select value={model} onChange={setModel} options={['Claude Sonnet 4.5', 'Claude Opus 4', 'GPT‑4o', 'Self-hosted']} />
        </Field>
      </div>

      {bindMcp && (
        <div style={{ marginTop: 16, padding: 14, background: 'rgba(184,137,58,0.12)', border: '1px solid var(--brass)' }}>
          <div className="smallcaps" style={{ fontSize: 10, color: 'var(--brass-deep)' }}>binding</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{bindMcp.name}</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 2 }}>{SHORT_ADDR(bindMcp.contract)} · {bindMcp.chain}</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 22, justifyContent: 'flex-end' }}>
        <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>
        <Btn kind="primary" disabled={!name} onClick={() => onCreate({
          name, vault, mcps: bindMcp ? [bindMcp.name] : [], status: 'active', runs: 0, lastRun: 'just now',
        })}>{bindMcp ? 'Bind & deploy' : 'Deploy agent'}</Btn>
      </div>
    </div>
  );
};

const ActivityFeed = ({ compact, agents }) => {
  const events = [
    { t: '6 min ago', who: 'Karel', what: 'called Aave.deposit', amount: '4,200 USDC', ok: true },
    { t: '23 min ago', who: 'Karel', what: 'called Curve.quote', amount: '15 routes', ok: true },
    { t: '1 hr ago', who: 'Vlasta', what: 'paused — exit threshold reached', amount: '', ok: false },
    { t: '3 hr ago', who: 'Vlasta', what: 'called Optimism.proveWithdrawal', amount: '0.4 ETH', ok: true },
    { t: 'yesterday', who: 'Bohumil', what: 'called Snapshot.castVote', amount: 'EIP-1234', ok: true },
    { t: 'yesterday', who: 'Karel', what: 'rejected — exceeded daily allowance', amount: '600 USDC', ok: false },
  ];
  const slice = compact ? events.slice(0, 5) : events;
  return (
    <div style={{ marginTop: 12, border: '1px solid var(--line)', background: 'rgba(241,233,212,0.5)' }}>
      {slice.map((e, i) => (
        <div key={i} style={{
          padding: '12px 16px', borderBottom: i < slice.length - 1 ? '1px solid var(--line-soft)' : 'none',
          display: 'grid', gridTemplateColumns: '90px 100px 1fr auto', gap: 12, alignItems: 'center',
        }}>
          <div className="smallcaps" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>{e.t}</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{e.who}</div>
          <div className="mono" style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{e.what}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {e.amount && <span className="mono" style={{ fontSize: 12 }}>{e.amount}</span>}
            <span style={{ color: e.ok ? 'var(--verdigris)' : 'var(--wine)' }}>{e.ok ? '✓' : '⚠'}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

const Activity = ({ agents }) => (
  <div>
    <h2 className="display" style={{ fontSize: 28, margin: 0 }}>Activity</h2>
    <p className="poetic" style={{ fontSize: 17, color: 'var(--ink-soft)', marginTop: 4 }}>Every bell that rang. Every one that didn't.</p>
    <ActivityFeed agents={agents} />
  </div>
);

const Settings = ({ user }) => (
  <div>
    <h2 className="display" style={{ fontSize: 28, margin: 0 }}>Settings</h2>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 18 }}>
      <div style={{ padding: 22, background: 'rgba(241,233,212,0.55)', border: '1px solid var(--line)' }}>
        <h3 className="display" style={{ fontSize: 18, margin: 0 }}>Profile</h3>
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          <Field label="Display name"><Input defaultValue={user.name} /></Field>
          <Field label="Email"><Input defaultValue={user.email} /></Field>
          <Field label="ENS / address"><Input className="mono" readOnly defaultValue={user.address} style={{ fontFamily: 'var(--font-mono)', background: 'var(--parchment-3)' }} /></Field>
        </div>
      </div>
      <div style={{ padding: 22, background: 'rgba(241,233,212,0.55)', border: '1px solid var(--line)' }}>
        <h3 className="display" style={{ fontSize: 18, margin: 0 }}>API & webhooks</h3>
        <div style={{ marginTop: 14, padding: 12, background: 'var(--ink)', color: 'var(--brass-bright)' }}>
          <div className="smallcaps" style={{ fontSize: 9, opacity: 0.5 }}>orloj api key</div>
          <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>orloj_pk_•••••••••••••••••••••</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Btn size="sm" kind="ghost">Reveal</Btn>
          <Btn size="sm" kind="ghost">Rotate</Btn>
        </div>
        <div style={{ marginTop: 18 }}>
          <Field label="Webhook URL"><Input placeholder="https://your-server.com/orloj-events" /></Field>
        </div>
      </div>
    </div>
  </div>
);

window.Profile = Profile;
