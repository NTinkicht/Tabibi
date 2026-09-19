type Locale = 'fr' | 'ar';

type Copy = {
  dir: 'ltr' | 'rtl';
  title: string;
  intro: string;
  queueHeading: string;
  queueBody: string;
  consultationHeading: string;
  consultationBody: string;
  privacyHeading: string;
  privacyBody: string;
};

const COPY: Record<Locale, Copy> = {
  fr: {
    dir: 'ltr',
    title: 'Comprendre vos estimations Tabibi',
    intro:
      'Les temps affichés sont des estimations qui évoluent avec la file réelle. Ils ne constituent pas une heure de passage garantie.',
    queueHeading: 'Temps d’attente',
    queueBody:
      'La fourchette d’attente est recalculée à partir de l’ordre de la file et des durées observées disponibles. Une urgence, une pause ou une consultation plus longue peut la faire évoluer.',
    consultationHeading: 'Consultation en cours',
    consultationBody:
      'Le temps restant est une approximation fondée sur la durée attendue et le temps déjà écoulé. La durée réelle dépend de la consultation.',
    privacyHeading: 'Votre vie privée',
    privacyBody:
      'Ces explications n’affichent ni identité d’un autre patient, ni motif de consultation, ni donnée clinique.',
  },
  ar: {
    dir: 'rtl',
    title: 'فهم تقديرات طبيبي',
    intro:
      'الأوقات المعروضة تقديرات تتغير مع حالة الطابور الفعلية، وليست موعدًا مضمونًا للدخول.',
    queueHeading: 'وقت الانتظار',
    queueBody:
      'يُعاد حساب نطاق الانتظار اعتمادًا على ترتيب الطابور والمدد المرصودة المتاحة. قد يتغير بسبب حالة طارئة أو توقف مؤقت أو استشارة أطول من المتوقع.',
    consultationHeading: 'الاستشارة جارية',
    consultationBody:
      'الوقت المتبقي تقريب يعتمد على المدة المتوقعة والوقت المنقضي. المدة الفعلية تعتمد على الاستشارة نفسها.',
    privacyHeading: 'خصوصيتك',
    privacyBody:
      'لا تعرض هذه التوضيحات هوية أي مريض آخر أو سبب الاستشارة أو أي بيانات سريرية.',
  },
};

export default async function GuestEtaExplainedPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const params = await searchParams;
  const locale: Locale = params.lang === 'ar' ? 'ar' : 'fr';
  const copy = COPY[locale];

  return (
    <main lang={locale} dir={copy.dir}>
      <h1>{copy.title}</h1>
      <p>{copy.intro}</p>
      <section aria-labelledby="queue-estimate-heading">
        <h2 id="queue-estimate-heading">{copy.queueHeading}</h2>
        <p>{copy.queueBody}</p>
      </section>
      <section aria-labelledby="consultation-estimate-heading">
        <h2 id="consultation-estimate-heading">{copy.consultationHeading}</h2>
        <p>{copy.consultationBody}</p>
      </section>
      <section aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">{copy.privacyHeading}</h2>
        <p>{copy.privacyBody}</p>
      </section>
      <nav aria-label={locale === 'ar' ? 'اللغة' : 'Langue'}>
        <a href="?lang=fr" lang="fr">Français</a>{' '}
        <a href="?lang=ar" lang="ar">العربية</a>
      </nav>
    </main>
  );
}
