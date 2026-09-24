import Link from 'next/link';

export default function GuestNotificationHelpPage() {
  return (
    <main>
      <section lang="fr" dir="ltr" aria-labelledby="notification-help-fr">
        <h1 id="notification-help-fr">Comprendre les notifications Tabibi</h1>
        <ul>
          <li>
            Les horaires et temps d’attente restent estimatifs et peuvent changer.
          </li>
          <li>
            Une notification de tour vous invite à suivre les instructions de la clinique.
          </li>
          <li>
            En cas de doute, vérifiez votre statut dans Tabibi plutôt que de
            répondre au message.
          </li>
        </ul>
        <p>
          Tabibi ne vous demandera jamais votre mot de passe ou un paiement dans
          une notification opérationnelle.
        </p>
        <Link href="/guest/status">Revenir au statut</Link>
      </section>
      <section lang="ar" dir="rtl" aria-labelledby="notification-help-ar">
        <h2 id="notification-help-ar">فهم إشعارات طبيبي</h2>
        <ul>
          <li>المواعيد وأوقات الانتظار تقديرية وقد تتغير.</li>
          <li>إشعار حلول الدور يدعوك إلى اتباع تعليمات العيادة.</li>
          <li>عند الشك، تحقق من حالتك داخل طبيبي بدلاً من الرد على الرسالة.</li>
        </ul>
        <p>لن يطلب منك طبيبي كلمة المرور أو الدفع داخل إشعار تشغيلي.</p>
        <Link href="/guest/status">العودة إلى الحالة</Link>
      </section>
    </main>
  );
}
