export type AccountLocale = 'ar' | 'fr';

export const accountStrings = {
  fr: {
    title: 'Mon compte patient',
    subtitleOut: 'Connectez-vous ou créez un compte pour gérer vos données.',
    signInTab: 'Se connecter',
    registerTab: 'Créer un compte',
    email: 'Adresse e-mail',
    displayName: 'Nom affiché',
    password: 'Mot de passe',
    passwordHint: 'Au moins 12 caractères.',
    signIn: 'Se connecter',
    register: 'Créer le compte',
    submitting: 'Envoi en cours…',
    errorSummary: 'Action impossible',
    failed:
      'Adresse e-mail ou mot de passe incorrect, ou compte temporairement verrouillé.',
    invalid:
      'Vérifiez les champs : adresse e-mail valide et mot de passe d’au moins 12 caractères.',
    rateLimited: 'Trop de tentatives. Réessayez plus tard.',
    unavailable: 'Service indisponible. Réessayez dans un instant.',
    registered:
      'Demande reçue. Si l’adresse est valide, vous pouvez maintenant vous connecter.',
    signedInAs: 'Connecté en tant que',
    signOut: 'Se déconnecter',
    otherLanguage: 'العربية',
  },
  ar: {
    title: 'حسابي كمريض',
    subtitleOut: 'سجّل الدخول أو أنشئ حسابًا لإدارة بياناتك.',
    signInTab: 'تسجيل الدخول',
    registerTab: 'إنشاء حساب',
    email: 'البريد الإلكتروني',
    displayName: 'الاسم المعروض',
    password: 'كلمة المرور',
    passwordHint: '12 حرفًا على الأقل.',
    signIn: 'تسجيل الدخول',
    register: 'إنشاء الحساب',
    submitting: 'جارٍ الإرسال…',
    errorSummary: 'تعذّر تنفيذ الإجراء',
    failed:
      'البريد الإلكتروني أو كلمة المرور غير صحيحة، أو الحساب مقفل مؤقتًا.',
    invalid:
      'تحقق من الحقول: بريد إلكتروني صالح وكلمة مرور من 12 حرفًا على الأقل.',
    rateLimited: 'محاولات كثيرة. حاول لاحقًا.',
    unavailable: 'الخدمة غير متاحة. حاول بعد قليل.',
    registered:
      'تم استلام الطلب. إن كان العنوان صالحًا يمكنك الآن تسجيل الدخول.',
    signedInAs: 'مسجّل الدخول باسم',
    signOut: 'تسجيل الخروج',
    otherLanguage: 'Français',
  },
} as const;
