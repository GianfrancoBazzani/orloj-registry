// Register MCP — multi-step wizard

const STEPS = [
  { n: 'I', t: 'Contract' },
  { n: 'II', t: 'Manifest' },
  { n: 'III', t: 'Capabilities' },
  { n: 'IV', t: 'Publish' },
];

const Register = ({ onNavigate }) => {
  const [step, setStep] = React.useState(0);
  const [form, setForm] = React.useState({
    address: '',
    chain: 'Ethereum',
    name: '',
    summary: '',
    visibility: 'public',
    audits: [],
    selectedFns: {},
  });
  const [scanning, setScanning] = React.useState(false);
  const [abi, setAbi] = React.useState(null);

  const valid0 = /^0x[a-fA-F0-9]{40}$/.test(form.address);

  const scan = () => {
    setScanning(true);
    setTimeout(() => {
      setAbi(MOCK_ABI);
      setForm(f => ({
        ...f,
        name: f.name || 'Pilatus Vault',
        summary: f.summary || 'A treasury orchestration interface with allowance scoping and emergency exits.',
        selectedFns: Object.fromEntries(MOCK_ABI.filter(x => x.kind === 'function').map(fn => [fn.name, fn.scope === 'read'])),
      }));
      setScanning(false);
    }, 1400);
  };

  const next = () => setStep(s => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep(s => Math.max(0, s - 1));

  return (
    <main style={{ padding: '40px 32px 80px' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
          <div>
            <Pill tone="brass" style={{ marginBottom: 10 }}>builders' gate</Pill>
            <h1 className="display" style={{ fontSize: 'clamp(36px, 5vw, 56px)', margin: 0, lineHeight: 1 }}>Cast a new bell</h1>
            <p className="poetic" style={{ fontSize: 20, color: 'var(--ink-soft)', marginTop: 8, marginBottom: 0 }}>
              Four movements until your interface joins the chime.
            </p>
          </div>
          <Btn kind="ghost" onClick={() => onNavigate('explore')}>← Back to registry</Btn>
        </div>

        {/* stepper */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0, marginTop: 24, border: '1px solid var(--line)', background: 'rgba(241,233,212,0.4)' }}>
          {STEPS.map((s, i) => {
            const done = i < step, active = i === step;
            return (
              <div key={i} style={{
                padding: '16px 20px', borderLeft: i === 0 ? 'none' : '1px solid var(--line)',
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--parchment)' : done ? 'var(--ink)' : 'var(--ink-soft)',
                position: 'relative',
              }}>
                <div className="display" style={{ fontSize: 24, color: active ? 'var(--brass-bright)' : done ? 'var(--brass-deep)' : 'var(--line)' }}>{s.n}</div>
                <div className="smallcaps" style={{ fontSize: 11, marginTop: 4 }}>
                  {done && '✓ '}{s.t}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 32, marginTop: 28, alignItems: 'flex-start' }}>
          <div style={{ padding: 32, background: 'rgba(241,233,212,0.5)', border: '1px solid var(--line)' }}>
            {step === 0 && <Step0 form={form} setForm={setForm} valid={valid0} scanning={scanning} abi={abi} onScan={scan} />}
            {step === 1 && <Step1 form={form} setForm={setForm} />}
            {step === 2 && <Step2 form={form} setForm={setForm} abi={abi} />}
            {step === 3 && <Step3 form={form} setForm={setForm} abi={abi} />}

            <div style={{ display: 'flex', gap: 12, marginTop: 32, paddingTop: 24, borderTop: '1px dashed var(--line)' }}>
              {step > 0 && <Btn kind="ghost" onClick={back}>← Back</Btn>}
              <div style={{ flex: 1 }} />
              {step < STEPS.length - 1
                ? <Btn kind="primary" onClick={next} disabled={(step === 0 && !abi)}>Continue →</Btn>
                : <Btn kind="brass" size="lg" onClick={() => onNavigate('explore')}>Strike the bell — publish</Btn>
              }
            </div>
          </div>

          <SidePreview form={form} abi={abi} step={step} />
        </div>
      </div>
    </main>
  );
};

const MOCK_ABI = [
  { kind: 'function', name: 'deposit', scope: 'write', sig: 'deposit(address asset, uint256 amount)', desc: 'Deposit ERC-20 into the vault.' },
  { kind: 'function', name: 'withdraw', scope: 'write', sig: 'withdraw(address asset, uint256 amount)', desc: 'Withdraw to the caller.' },
  { kind: 'function', name: 'setAllowance', scope: 'write', sig: 'setAllowance(address agent, uint256 cap)', desc: 'Cap an agent\'s daily spend.' },
  { kind: 'function', name: 'emergencyExit', scope: 'write', sig: 'emergencyExit()', desc: 'Pull all funds to admin.' },
  { kind: 'function', name: 'balanceOf', scope: 'read', sig: 'balanceOf(address asset) view', desc: 'Vault balance for asset.' },
  { kind: 'function', name: 'allowance', scope: 'read', sig: 'allowance(address agent) view', desc: 'Remaining spend.' },
  { kind: 'function', name: 'positions', scope: 'read', sig: 'positions() view', desc: 'All open positions.' },
  { kind: 'event', name: 'Deposited', sig: 'Deposited(address,address,uint256)' },
  { kind: 'event', name: 'Withdrawn', sig: 'Withdrawn(address,address,uint256)' },
];

const Step0 = ({ form, setForm, valid, scanning, abi, onScan }) => (
  <div>
    <h3 className="display" style={{ fontSize: 22, margin: 0 }}>I. The contract</h3>
    <p style={{ color: 'var(--ink-soft)', marginTop: 6, marginBottom: 24, fontSize: 14 }}>
      Paste a verified address. ORLOJ resolves the ABI from Sourcify, Etherscan, or your uploaded JSON.
    </p>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12 }}>
      <Field label="Contract address">
        <Input className="mono" value={form.address} onChange={(e) => setForm(f => ({ ...f, address: e.target.value }))} placeholder="0x…" style={{ fontFamily: 'var(--font-mono)' }} />
      </Field>
      <Field label="Chain">
        <Select value={form.chain} onChange={(v) => setForm(f => ({ ...f, chain: v }))} options={['Ethereum', 'Optimism', 'Base', 'Arbitrum', 'Gnosis', 'Polygon']} />
      </Field>
    </div>

    <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {['0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'].map(a => (
        <button key={a} onClick={() => setForm(f => ({ ...f, address: a }))} className="mono" style={{
          fontSize: 11, padding: '4px 8px', border: '1px solid var(--line)',
          background: 'transparent', color: 'var(--ink-soft)', cursor: 'pointer',
        }}>try {SHORT_ADDR(a)}</button>
      ))}
    </div>

    <div style={{ marginTop: 24 }}>
      <Btn kind="primary" onClick={onScan} disabled={!valid || scanning}>
        {scanning ? 'Reading the cogs…' : abi ? '✓ ABI resolved — re-scan' : 'Resolve ABI →'}
      </Btn>
      {valid && !abi && !scanning && <span style={{ marginLeft: 14, color: 'var(--ink-soft)', fontSize: 13 }}>address valid · click to fetch</span>}
    </div>

    {scanning && <ScanShimmer />}

    {abi && !scanning && (
      <div style={{ marginTop: 24, padding: 16, background: 'rgba(47,110,94,0.08)', border: '1px solid var(--verdigris)', borderLeft: '3px solid var(--verdigris)' }}>
        <div className="smallcaps" style={{ color: 'var(--verdigris-deep)', fontSize: 11 }}>✓ verified · sourcify · 0.8.21</div>
        <div style={{ marginTop: 6, fontSize: 14 }}>
          Found <strong>{abi.filter(x => x.kind === 'function').length}</strong> functions and <strong>{abi.filter(x => x.kind === 'event').length}</strong> events.
        </div>
      </div>
    )}
  </div>
);

const ScanShimmer = () => (
  <div style={{ marginTop: 20, padding: 16, background: 'var(--ink)', color: 'var(--parchment)' }}>
    <div className="mono" style={{ fontSize: 11, opacity: 0.6 }}>$ orloj resolve --address 0x… --chain ethereum</div>
    {['fetching sourcify metadata…', 'matching bytecode hash…', 'extracting natspec…', 'classifying read/write fns…'].map((l, i) => (
      <div key={i} className="mono" style={{ fontSize: 12, marginTop: 6, color: 'var(--brass-bright)', animation: `fade-${i} 1.4s ease`, opacity: 0.85 }}>
        <span style={{ display: 'inline-block', width: 14 }}>·</span> {l}
      </div>
    ))}
  </div>
);

const Step1 = ({ form, setForm }) => (
  <div>
    <h3 className="display" style={{ fontSize: 22, margin: 0 }}>II. The manifest</h3>
    <p style={{ color: 'var(--ink-soft)', marginTop: 6, marginBottom: 24, fontSize: 14 }}>
      Tell operators what they're binding to. This becomes the public listing card.
    </p>
    <div style={{ display: 'grid', gap: 16 }}>
      <Field label="Public name" hint="Will appear in the registry. 60 chars max.">
        <Input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Pilatus Vault" />
      </Field>
      <Field label="One-line summary" hint="What does this MCP let an agent do?">
        <textarea value={form.summary} onChange={(e) => setForm(f => ({ ...f, summary: e.target.value }))} rows={3} style={{
          width: '100%', padding: 12, background: 'rgba(255,255,255,0.45)', border: '1px solid var(--line)',
          fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--ink)', borderRadius: 0, resize: 'vertical',
        }} />
      </Field>
      <Field label="Visibility">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <ChoiceCard
            active={form.visibility === 'public'}
            onClick={() => setForm(f => ({ ...f, visibility: 'public' }))}
            icon={<GearIcon size={26} />}
            title="Public registry"
            desc="Listed for everyone. Indexed in search and the homepage."
          />
          <ChoiceCard
            active={form.visibility === 'unlisted'}
            onClick={() => setForm(f => ({ ...f, visibility: 'unlisted' }))}
            icon={<GearIcon size={26} />}
            title="Unlisted"
            desc="Hidden from search. Anyone with the manifest URL can bind."
          />
        </div>
      </Field>
      <Field label="Audit attestations (optional)" hint="Add firms that have reviewed this contract. We'll fetch the report hash automatically.">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          {['Trail of Bits', 'OpenZeppelin', 'Spearbit', 'Cantina', 'Certora', 'Sigma Prime'].map(a => {
            const on = form.audits.includes(a);
            return (
              <button key={a} onClick={() => setForm(f => ({ ...f, audits: on ? f.audits.filter(x => x !== a) : [...f.audits, a] }))} className="smallcaps" style={{
                padding: '6px 12px', fontSize: 11, fontFamily: 'var(--font-ui)',
                background: on ? 'var(--verdigris)' : 'transparent', color: on ? 'var(--parchment)' : 'var(--ink-soft)',
                border: `1px solid ${on ? 'var(--verdigris-deep)' : 'var(--line)'}`,
                cursor: 'pointer',
              }}>{on && '✓ '}{a}</button>
            );
          })}
        </div>
      </Field>
    </div>
  </div>
);

const Step2 = ({ form, setForm, abi }) => {
  const fns = (abi || []).filter(x => x.kind === 'function');
  const toggle = (name) => setForm(f => ({ ...f, selectedFns: { ...f.selectedFns, [name]: !f.selectedFns[name] } }));
  const enabledCount = Object.values(form.selectedFns || {}).filter(Boolean).length;
  return (
    <div>
      <h3 className="display" style={{ fontSize: 22, margin: 0 }}>III. Capabilities</h3>
      <p style={{ color: 'var(--ink-soft)', marginTop: 6, marginBottom: 8, fontSize: 14 }}>
        Choose which functions become tools. Keep dangerous ones gated behind explicit operator opt-in.
      </p>
      <div style={{ display: 'flex', gap: 16, marginBottom: 18 }}>
        <Pill tone="verdigris">{enabledCount} of {fns.length} exposed</Pill>
        <button onClick={() => setForm(f => ({ ...f, selectedFns: Object.fromEntries(fns.map(fn => [fn.name, fn.scope === 'read'])) }))} className="smallcaps" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brass-deep)', fontSize: 11, fontFamily: 'var(--font-ui)' }}>↺ reads only</button>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {fns.map(fn => {
          const on = form.selectedFns[fn.name];
          const dangerous = fn.name === 'emergencyExit' || fn.name === 'setAllowance';
          return (
            <div key={fn.name} onClick={() => toggle(fn.name)} style={{
              padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center',
              background: on ? 'rgba(184,137,58,0.12)' : 'rgba(255,255,255,0.4)',
              border: on ? '1px solid var(--brass)' : '1px solid var(--line)',
              cursor: 'pointer',
            }}>
              <div style={{
                width: 18, height: 18, border: `1.5px solid ${on ? 'var(--brass-deep)' : 'var(--line)'}`,
                background: on ? 'var(--brass)' : 'transparent', display: 'grid', placeItems: 'center',
              }}>
                {on && <span style={{ color: 'var(--ink)', fontSize: 12, lineHeight: 1 }}>✓</span>}
              </div>
              <div style={{ flex: 1 }}>
                <div className="mono" style={{ fontSize: 13, color: 'var(--ink)' }}>{fn.sig}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>{fn.desc}</div>
              </div>
              {fn.scope === 'read' ? <Pill tone="verdigris">read</Pill> : dangerous ? <Pill tone="wine">danger</Pill> : <Pill tone="brass">write</Pill>}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Step3 = ({ form, abi }) => (
  <div>
    <h3 className="display" style={{ fontSize: 22, margin: 0 }}>IV. Sign &amp; publish</h3>
    <p style={{ color: 'var(--ink-soft)', marginTop: 6, marginBottom: 24, fontSize: 14 }}>
      We'll EIP-712 sign the manifest with your connected wallet, pin it to IPFS, and notify ORLOJ indexers.
    </p>
    <div style={{ padding: 18, background: 'var(--ink)', color: 'var(--parchment)', maxHeight: 320, overflow: 'auto' }}>
      <pre className="mono" style={{ fontSize: 11.5, lineHeight: 1.6, margin: 0 }}>{`{
  "schema": "orloj.manifest/v0.4",
  "name":   "${form.name || 'Untitled MCP'}",
  "summary":"${form.summary || ''}",
  "chain":  "${form.chain}",
  "address":"${form.address || '0x...'}",
  "visibility": "${form.visibility}",
  "audits": ${JSON.stringify(form.audits)},
  "tools": [
${(abi || []).filter(x => x.kind === 'function' && form.selectedFns[x.name]).map(fn => `    { "name": "${fn.name}", "sig": "${fn.sig}", "scope": "${fn.scope}" }`).join(',\n')}
  ],
  "publisher": "you.eth"
}`}</pre>
    </div>
    <div style={{ marginTop: 16, padding: 14, background: 'rgba(184,137,58,0.12)', border: '1px solid var(--brass)', display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13 }}>
      <span style={{ color: 'var(--brass-deep)', fontSize: 18 }}>⚠</span>
      <span>Once struck, the manifest hash is immutable. Future revisions are append-only — operators can pin to v0.4 indefinitely.</span>
    </div>
  </div>
);

const SidePreview = ({ form, abi, step }) => (
  <div style={{ position: 'sticky', top: 24 }}>
    <div className="smallcaps" style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 10 }}>✦ live preview ✦</div>
    <FramedCard tone="paper" padding={20}>
      <div style={{ height: 80, margin: '-20px -20px 16px', background: 'var(--verdigris)', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, opacity: 0.45 }}><StainedPanel seed={form.address.length || 1} width={400} height={80} /></div>
      </div>
      <div className="display" style={{ fontSize: 18 }}>{form.name || 'Untitled MCP'}</div>
      <div style={{ fontSize: 12, color: 'var(--verdigris-deep)', marginTop: 4 }}>by you.eth · on {form.chain}</div>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 10, lineHeight: 1.5, minHeight: 60 }}>{form.summary || 'A short description will appear here…'}</p>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
        <div>
          <div className="smallcaps" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>tools</div>
          <div className="mono" style={{ fontSize: 14 }}>{Object.values(form.selectedFns || {}).filter(Boolean).length}</div>
        </div>
        <div>
          <div className="smallcaps" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>audits</div>
          <div className="mono" style={{ fontSize: 14 }}>{form.audits.length}</div>
        </div>
        <div>
          <div className="smallcaps" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>visibility</div>
          <div className="mono" style={{ fontSize: 14 }}>{form.visibility}</div>
        </div>
      </div>
    </FramedCard>

    <div style={{ marginTop: 16, padding: 16, background: 'rgba(241,233,212,0.4)', border: '1px solid var(--line)' }}>
      <div className="smallcaps" style={{ fontSize: 11, color: 'var(--ink-soft)', marginBottom: 8 }}>checks</div>
      {[
        ['Address valid', /^0x[a-fA-F0-9]{40}$/.test(form.address)],
        ['ABI resolved', !!abi],
        ['Manifest filled', form.name.length > 2 && form.summary.length > 8],
        ['Capabilities chosen', Object.values(form.selectedFns || {}).filter(Boolean).length > 0],
      ].map(([l, ok]) => (
        <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', color: ok ? 'var(--verdigris-deep)' : 'var(--ink-soft)' }}>
          <span>{ok ? '✓' : '○'} {l}</span>
        </div>
      ))}
    </div>
  </div>
);

window.Register = Register;
