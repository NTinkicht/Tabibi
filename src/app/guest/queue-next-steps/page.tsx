import Link from 'next/link';

export default function GuestQueueNextStepsPage() {
  return (
    <main>
      <section lang="fr" dir="ltr" aria-labelledby="queue-next-fr">
        <h1 id="queue-next-fr">Que faire pendant l’attente</h1>
        <ol>
          <li>Gardez votre page de statut accessible et consultez-la pour les mises à jour.</li>
          <li>Considérez l’heure affichée comme une estimation, pas comme une garantie.</li>
          <li>Lorsque votre tour approche, suivez les indications de la clinique.</li>
        </ol>
        <Link href="/guest/queue-arrival-help">Voir les consignes d’arrivée</Link>
      </section>
      <section lang="ar" dir="rtl" aria-labelledby="queue-next-ar">
        <h2 id="queue-next-ar">ماذا تفعل أثناء الانتظار</h2>
        <ol>
          <li>احتفظ بصفحة الحالة متاحة وتحقق منها لمعرفة التحديثات.</li>
          <li>اعتبر الوقت المعروض تقديراً وليس ضماناً.</li>
          <li>عندما يقترب دورك، اتبع تعليمات العيادة.</li>
        </ol>
        <Link href="/guest/queue-arrival-help">عرض تعليمات الوصول</Link>
      </section>
    </main>
  );
}
