import Link from 'next/link';
import { GuestHelpSection, GuestHelpShell } from '../help-layout';

export default function GuestNotificationHelpPage() {
  return (
    <GuestHelpShell>
      <GuestHelpSection locale="fr" labelledBy="notification-help-fr">
        <h1 id="notification-help-fr">Comprendre les notifications Tabibi</h1>
        <ul>
          <li>
            Les horaires et temps d’attente restent estimatifs et peuvent
            changer.
          </li>
          <li>
            Une notification de tour vous invite à suivre les instructions de la
            clinique.
          </li>
          <li>
            En cas de doute, vérifiez votre statut dans Tabibi plutôt que de
            répondre au message.
          </li>
          <li>
            Si vous activez les notifications sur cet appareil, l’écran de
            verrouillage affiche seulement « Tabibi » et une phrase générale,
            sans nom de clinique, de médecin ni de position.
          </li>
          <li>
            Vous pouvez les désactiver à tout moment avec le bouton « Désactiver
            » de la carte Notifications, ou dans les réglages du site de votre
            navigateur.
          </li>
        </ul>
        <p>
          Tabibi ne vous demandera jamais votre mot de passe ou un paiement dans
          une notification opérationnelle.
        </p>
        <Link href="/guest/status">Revenir au statut</Link>
        <div>
          <Link href="/guest/queue-next-steps">
            Consulter les étapes pendant l’attente
          </Link>
        </div>
      </GuestHelpSection>
      <GuestHelpSection locale="ar" labelledBy="notification-help-ar">
        <h1 id="notification-help-ar">فهم إشعارات طبيبي</h1>
        <ul>
          <li>المواعيد وأوقات الانتظار تقديرية وقد تتغير.</li>
          <li>إشعار حلول الدور يدعوك إلى اتباع تعليمات العيادة.</li>
          <li>عند الشك، تحقق من حالتك داخل طبيبي بدلاً من الرد على الرسالة.</li>
          <li>
            إذا فعّلت الإشعارات على هذا الجهاز، تعرض شاشة القفل كلمة «Tabibi»
            وجملة عامة فقط، دون اسم العيادة أو الطبيب أو رقم الدور.
          </li>
          <li>
            يمكنك إيقافها في أي وقت بزر «إيقاف» في بطاقة الإشعارات، أو من
            إعدادات موقع المتصفح.
          </li>
        </ul>
        <p>لن يطلب منك طبيبي كلمة المرور أو الدفع داخل إشعار تشغيلي.</p>
        <Link href="/guest/status">العودة إلى الحالة</Link>
        <div>
          <Link href="/guest/queue-next-steps">مراجعة خطوات الانتظار</Link>
        </div>
      </GuestHelpSection>
    </GuestHelpShell>
  );
}
