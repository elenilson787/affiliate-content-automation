export default function Home() {
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 32 }}>
      <h1>Affiliate Content Automation</h1>
      <p>Automação simples para encontrar ofertas, gerar conteúdo e publicar em vários canais.</p>
      <div style={{ display: "grid", gap: 12, marginTop: 24 }}>
        <div><strong>Afiliados:</strong> Shopee · Amazon · Mercado Livre · Magalu · AliExpress</div>
        <div><strong>Canais:</strong> Telegram · WhatsApp · Facebook · Instagram · Threads</div>
        <div><strong>Pipeline:</strong> Busca → Filtro → Conteúdo → Fila → Publicação</div>
      </div>
    </main>
  );
}
