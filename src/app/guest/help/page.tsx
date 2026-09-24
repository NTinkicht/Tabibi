import Link from 'next/link';

export default function GuestHelpHubPage() {
  return (
    <main className="pageShell" data-testid="guest-help-hub">
      <section lang="fr" dir="ltr" aria-labelledby="guest-help-fr">
        <h1 id="guest-help-fr">Aide pour votre parcours invité</h1>
        <h2>Avant la réservation</h2>
        <ul>
          <li>
            <Link href="/guest/booking-help">Préparer votre réservation</Link>
          </li>
          <li>
            <Link href="/guest/booking-contact-help">
              Comprendre les coordonnées requises
            </Link>
          </li>
          <li>
            <Link href="/guest/privacy-help">Protéger vos informations</Link>
          </li>
        </ul>
        <h2>Après la réservation</h2>
        <ul>
          <li>
            <Link href="/guest/notification-help">
              Comprendre les notifications
            </Link>
          </li>
          <li>
            <Link href="/guest/queue-next-steps">
              Que faire pendant l’attente
            </Link>
          </li>
          <li>
            <Link href="/guest/queue-arrival-help">
              À votre arrivée à la clinique
            </Link>
          </li>
          <li>
            <Link href="/guest/eta-explained?lang=fr">
              Comprendre le temps d’attente estimé
            </Link>
          </li>
        </ul>
      </section>

      <section lang="ar" dir="rtl" aria-labelledby="guest-help-ar">
        <h1 id="guest-help-ar">مساعدة خلال رحلة الحجز كضيف</h1>
        <h2>قبل الحجز</h2>
        <ul>
          <li>
            <Link href="/guest/booking-help">الاستعداد للحجز</Link>
          </li>
          <li>
            <Link href="/guest/booking-contact-help">
              فهم بيانات التواصل المطلوبة
            </Link>
          </li>
          <li>
            <Link href="/guest/privacy-help">حماية معلوماتك</Link>
          </li>
        </ul>
        <h2>بعد الحجز</h2>
        <ul>
          <li>
            <Link href="/guest/notification-help">فهم الإشعارات</Link>
          </li>
          <li>
            <Link href="/guest/queue-next-steps">خطوات الانتظار</Link>
          </li>
          <li>
            <Link href="/guest/queue-arrival-help">عند الوصول إلى العيادة</Link>
          </li>
          <li>
            <Link href="/guest/eta-explained?lang=ar">
              فهم وقت الانتظار التقديري
            </Link>
          </li>
        </ul>
      </section>
    </main>
  );
}
