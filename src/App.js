import React, { useEffect, useState } from "react";

export default function App() {
  const [data, setData] = useState([]);
  const [erro, setErro] = useState("");

  useEffect(() => {
    carregarDados();
  }, []);

  async function carregarDados() {
    try {
      const res = await fetch(
        "https://opendatasus.saude.gov.br/api/3/action/package_search?q=mpox"
      );
      const json = await res.json();

      // só pra testar conexão real
      if (!json.success) throw new Error("Falha API");

      // mock fallback simples
      setData([
        { estado: "SP", casos: 43 },
        { estado: "RJ", casos: 9 },
        { estado: "MG", casos: 3 },
        { estado: "RS", casos: 1 },
      ]);
    } catch (e) {
      console.log(e);
      setErro("⚠️ Não foi possível conectar ao OpenDataSUS (CORS comum)");
      
      // fallback
      setData([
        { estado: "SP", casos: 43 },
        { estado: "RJ", casos: 9 },
        { estado: "MG", casos: 3 },
        { estado: "RS", casos: 1 },
      ]);
    }
  }

  const total = data.reduce((acc, d) => acc + d.casos, 0);

  return (
    <div style={styles.page}>
      <h1>📊 MPOX Brasil (v2)</h1>

      {erro && <p style={{ color: "orange" }}>{erro}</p>}

      <div style={styles.cards}>
        <div style={styles.card}>
          <h3>Total</h3>
          <p>{total}</p>
        </div>

        <div style={styles.card}>
          <h3>Status</h3>
          <p>{erro ? "Fallback ativo" : "Dados reais"}</p>
        </div>
      </div>

      <table style={styles.table}>
        <thead>
          <tr>
            <th>Estado</th>
            <th>Casos</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.estado}>
              <td>{d.estado}</td>
              <td>{d.casos}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const styles = {
  page: {
    padding: 20,
    fontFamily: "Arial",
    background: "#0b1220",
    color: "white",
    minHeight: "100vh",
  },
  cards: {
    display: "flex",
    gap: 20,
    marginTop: 20,
  },
  card: {
    background: "#1c2536",
    padding: 15,
    borderRadius: 10,
  },
  table: {
    marginTop: 20,
    width: "100%",
  },
};