// Top-level App

const { useState, useEffect } = React;

const App = () => {
  const [route, setRoute] = useState('home'); // home | explore | register | profile | docs
  const [user, setUser] = useState(null);
  const [showLogin, setShowLogin] = useState(false);
  const [bindMcp, setBindMcp] = useState(null); // staged MCP being bound

  // hash routing
  useEffect(() => {
    const apply = () => {
      const h = (window.location.hash || '').replace('#', '') || 'home';
      setRoute(['home', 'explore', 'register', 'profile', 'docs'].includes(h) ? h : 'home');
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  const navigate = (r) => {
    if ((r === 'profile' || r === 'register') && !user) {
      setShowLogin(true);
      return;
    }
    window.location.hash = '#' + r;
    setRoute(r);
    window.scrollTo({ top: 0 });
  };

  const handleLogin = (provider) => {
    setUser({
      name: 'Vlastimil Hrabal',
      email: 'vlastimil@studio.eth',
      address: 'vlastimil.eth',
      plan: 'Studio',
      joined: 'Mar 2026',
      provider,
    });
    setShowLogin(false);
  };

  const handleBind = (m) => {
    setBindMcp(m);
    if (!user) { setShowLogin(true); return; }
    navigate('profile');
  };

  return (
    <>
      <TopNav route={route} onNavigate={navigate} user={user} onLogin={() => setShowLogin(true)} onLogout={() => setUser(null)} />
      {route === 'home' && <Landing onNavigate={navigate} onLogin={() => setShowLogin(true)} />}
      {route === 'explore' && <Explore onNavigate={navigate} onBind={handleBind} />}
      {route === 'register' && <Register onNavigate={navigate} />}
      {route === 'profile' && user && <Profile user={user} onNavigate={navigate} bindMcp={bindMcp} onClearBind={() => setBindMcp(null)} />}
      {route === 'docs' && <DocsStub onNavigate={navigate} />}
      <Footer onNavigate={navigate} />
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} onLogin={handleLogin} />}
    </>
  );
};

const DocsStub = ({ onNavigate }) => (
  <main style={{ padding: '60px 32px 80px', maxWidth: 900, margin: '0 auto' }}>
    <Pill tone="brass">documentation</Pill>
    <h1 className="display" style={{ fontSize: 56, margin: '14px 0 8px' }}>Manuals & Manifests</h1>
    <p className="poetic" style={{ fontSize: 22, color: 'var(--ink-soft)', margin: 0 }}>The mechanism, written down.</p>

    <Divider />

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginTop: 32 }}>
      {[
        { t: 'Manifest schema', d: 'EIP-712 typed data, optional capabilities tree, audit attestations.', l: 'orloj.manifest/v0.4' },
        { t: 'Operator quickstart', d: 'Bind your first MCP, set spend policies, watch the trace.', l: '/quickstart' },
        { t: 'Builder quickstart', d: 'From verified address to public listing in 90 seconds.', l: '/builders' },
        { t: 'Vault providers', d: 'Turnkey, Fireblocks, Lit Protocol, Privy, self-custody.', l: '/vaults' },
        { t: 'API reference', d: 'REST + JSON-RPC over the indexer. Webhooks & EventSource.', l: '/api' },
        { t: 'Glossary', d: 'MCP, manifest, vault, agent, scope, strike.', l: '/glossary' },
      ].map(d => (
        <div key={d.t} style={{ padding: 18, background: 'rgba(241,233,212,0.55)', border: '1px solid var(--line)', cursor: 'pointer' }}>
          <div className="display" style={{ fontSize: 16 }}>{d.t}</div>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 6, lineHeight: 1.5 }}>{d.d}</p>
          <div className="mono" style={{ fontSize: 11, color: 'var(--brass-deep)', marginTop: 8 }}>{d.l} →</div>
        </div>
      ))}
    </div>
  </main>
);

const Footer = ({ onNavigate }) => (
  <footer style={{
    marginTop: 60, padding: '40px 32px',
    background: 'var(--ink)', color: 'var(--parchment)',
    borderTop: '4px solid var(--brass)',
  }}>
    <div style={{ maxWidth: 1280, margin: '0 auto', display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr', gap: 32, alignItems: 'flex-start' }}>
      <div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <OrlojMark size={42} />
          <div>
            <div className="display" style={{ fontSize: 20, letterSpacing: '0.22em' }}>ORLOJ</div>
            <div className="smallcaps" style={{ fontSize: 9, color: 'var(--brass-bright)', marginTop: 2 }}>since 2026 · staré město</div>
          </div>
        </div>
        <p className="poetic" style={{ fontSize: 16, marginTop: 14, color: 'rgba(241,233,212,0.7)', maxWidth: 360 }}>
          The astronomical registry for smart interfaces. An OpenZeppelin-stewarded public good, presented at ETHPrague 2026.
        </p>
      </div>
      <FooterCol title="product" items={[['Explore', 'explore'], ['Register', 'register'], ['Profile', 'profile'], ['Docs', 'docs']]} onNavigate={onNavigate} />
      <FooterCol title="builders" items={[['Manifest spec', 'docs'], ['CLI', 'docs'], ['SDKs', 'docs'], ['Audits', 'docs']]} onNavigate={onNavigate} />
      <FooterCol title="society" items={[['Open RFCs', 'docs'], ['Code of conduct', 'docs'], ['Contact', 'docs']]} onNavigate={onNavigate} />
    </div>
    <div style={{ maxWidth: 1280, margin: '40px auto 0', borderTop: '1px solid rgba(241,233,212,0.18)', paddingTop: 20, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, color: 'rgba(241,233,212,0.5)', fontSize: 12 }}>
      <div>© 2026 ORLOJ Foundation · z.ú., Praha</div>
      <div className="mono">manifest_v0.4 · indexer 81f2a · hello@orloj.eth</div>
    </div>
  </footer>
);

const FooterCol = ({ title, items, onNavigate }) => (
  <div>
    <div className="smallcaps" style={{ fontSize: 11, color: 'var(--brass-bright)', marginBottom: 10 }}>{title}</div>
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
      {items.map(([l, r]) => (
        <li key={l}><button onClick={() => onNavigate(r)} style={{
          background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(241,233,212,0.85)',
          fontFamily: 'var(--font-ui)', fontSize: 13, padding: 0,
        }}>{l}</button></li>
      ))}
    </ul>
  </div>
);

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
