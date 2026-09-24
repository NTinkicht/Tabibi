import Link from 'next/link';

export default function GuestQueueArrivalHelpPage() {
  return (
    <main>
      <section lang="fr" dir="ltr" aria-labelledby="queue-arrival-fr">
        <h1 id="queue-arrival-fr">À votre arrivée à la clinique</h1>
        <p>
          Gardez votre page de file d’attente ouverte et suivez uniquement le
          statut affiché pour votre réservation.
        </p>
        <ul>
          <li>Confirmez votre présence lorsque le bouton est disponible.</li>
          <li>Actualisez le statut si votre connexion a été interrompue.</li>
          <li>
            Revenez depuis votre lien de réservation si votre accès a expiré.
          </li>
        </ul>
        <Link href="/guest/eta-explained?lang=fr">
          Comprendre le temps d’attente
        </Link>
        <div>
          <Link href="/guest/queue-next-steps">
            Revoir les étapes pendant l’attente
          </Link>
        </div>
      </section>

      <section lang="ar" dir="rtl" aria-labelledby="queue-arrival-ar">
        <h1 id="queue-arrival-ar">عند وصولك إلى العيادة</h1>
        <p>أبقِ صفحة قائمة الانتظار مفتوحة واتبع الحالة المعروضة لحجزك فقط.</p>
        <ul>
          <li>أكد حضورك عندما يظهر زر التأكيد.</li>
          <li>حدّث الحالة إذا انقطع اتصالك.</li>
          <li>عد من رابط الحجز الخاص بك إذا انتهت صلاحية الوصول.</li>
        </ul>
        <Link href="/guest/eta-explained?lang=ar">فهم وقت الانتظار</Link>
        <div>
          <Link href="/guest/queue-next-steps">مراجعة خطوات الانتظار</Link>
        </div>
      </section>
    </main>
  );
}
