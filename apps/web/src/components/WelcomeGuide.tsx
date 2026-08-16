"use client";

import { motion } from "framer-motion";

export function WelcomeGuide() {
  const steps = [
    {
      title: "Kanal ekle",
      text: "Sol alttan Kick kullanıcı adı veya kanal URL’si ile kanal ekleyin.",
    },
    {
      title: "VOD seç",
      text: "Kanalın Yayınlar sekmesinden bir VOD seçin; Kick üzerinden anında önizleme açılır (tam indirme yok).",
    },
    {
      title: "Kes ve yayınla",
      text: "In/Out ile kesiti seçin; yalnızca o aralık yüksek kalitede indirilir ve YouTube’a yüklenir.",
    },
  ];

  return (
    <div className="welcome">
      <motion.div
        className="welcome-hero"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
      >
        <p className="eyebrow">CutMuck</p>
        <h1>Kick’ten kes, YouTube’a gönder</h1>
        <p className="lede">
          Kanalları takip edin, VOD’ları indirin, basit kesim yapın ve YouTube’a otomatik yükleyin.
          Ayarlardan YouTube OAuth bilgilerini girerek uçtan uca akışı tamamlayın.
        </p>
      </motion.div>
      <div className="welcome-steps">
        {steps.map((s, i) => (
          <motion.div
            key={s.title}
            className="welcome-step"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 + i * 0.08 }}
          >
            <span className="step-num">{i + 1}</span>
            <div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
