"""Townsfolk names (folk.md 4.2): 150 female and 150 male first names and 200 surnames in the cast's mix.

No first name here is a named character's or one the cast generator can draw (cast.FEMALE, cast.MALE, cast.NAMED),
so a townsperson never shares a first name with one of the 60; `folk_gen` keeps full names unique.
"""

FEMALE = [
    "Abigail", "Ada", "Adina", "Alma", "Alona", "Anat", "Ayala", "Ayelet", "Bat-El", "Batya",
    "Bracha", "Carmela", "Chava", "Danielle", "Daphna", "Dikla", "Dorit", "Edna", "Einav", "Ella",
    "Elinor", "Esti", "Ester", "Gefen", "Gila", "Hadas", "Hadar", "Hagit", "Ilana", "Irit",
    "Liora", "Karin", "Kinneret", "Lilach", "Limor", "Liron", "Malka", "Margalit", "Maayan", "Meital",
    "Meirav", "Mika", "Moran", "Naama", "Nava", "Nechama", "Nili", "Nirit", "Noya", "Ofra",
    "Ora", "Orit", "Orna", "Osnat", "Pnina", "Rachel", "Rakefet", "Reut", "Rivka", "Romi",
    "Rona", "Ruti", "Sapir", "Shachar", "Sharon", "Shelly", "Shimrit", "Shir", "Shlomit", "Shoshana",
    "Sigal", "Smadar", "Stav", "Tali", "Tova", "Tzipi", "Vered", "Yaara", "Yafit", "Yehudit",
    "Yifat", "Yona", "Zehava", "Ziva", "Zohar", "Aisha", "Amal", "Asma", "Basma", "Dalal",
    "Duha", "Fatima", "Ghada", "Hala", "Hanan", "Huda", "Iman", "Jamila", "Lama", "Lubna",
    "Maha", "Manal", "Maram", "Mariam", "Maysa", "Muna", "Nada", "Najwa", "Nawal", "Nour",
    "Rania", "Rasha", "Reem", "Rima", "Rula", "Sahar", "Salma", "Samira", "Sana", "Suha",
    "Wafa", "Yara", "Zeina", "Anna", "Clara", "Daria", "Elena", "Eva", "Irina", "Julia",
    "Katya", "Larisa", "Marina", "Natalia", "Olga", "Polina", "Sofia", "Svetlana", "Vera", "Alina",
    "Emma", "Grace", "Hannah", "Lucy", "Maria", "Nina", "Paula", "Rosa", "Sylvie", "Zoe",
]

MALE = [
    "Aharon", "Alon", "Amit", "Amnon", "Ariel", "Arik", "Assaf", "Avner", "Avraham", "Baruch",
    "Benny", "Chaim", "Dan", "Daniel", "Dov", "Doron", "Dudi", "Ehud", "Elazar", "Eliav",
    "Eliran", "Eran", "Eyal", "Gadi", "Gideon", "Hagai", "Harel", "Ilan", "Itzik", "Kobi",
    "Lavi", "Liad", "Matan", "Meir", "Menachem", "Micha", "Mordechai", "Nadav", "Nahum", "Natan",
    "Nimrod", "Ofer", "Ohad", "Omri", "Or", "Oz", "Pinchas", "Raz", "Reuven", "Ron",
    "Saar", "Shalom", "Shaul", "Shimon", "Shlomo", "Tal", "Tzvi", "Udi", "Yair", "Yakov",
    "Yehuda", "Yigal", "Yishai", "Yoav", "Yonatan", "Yosef", "Zeev", "Zvika", "Adam", "Barak",
    "Ahmad", "Ali", "Amin", "Anas", "Bassam", "Bilal", "Fares", "Faris", "Ghassan", "Hamza",
    "Hassan", "Hussein", "Ibrahim", "Imad", "Issa", "Jamal", "Jawad", "Khaled", "Mahmoud", "Majd",
    "Marwan", "Mazen", "Mohammad", "Mustafa", "Nabil", "Nasser", "Rafiq", "Raed", "Saleh", "Salim",
    "Samer", "Tarek", "Wael", "Walid", "Yasin", "Youssef", "Ziad", "Alexei", "Andrei", "Boris",
    "Dmitri", "Igor", "Ilya", "Kirill", "Leonid", "Maxim", "Mikhail", "Nikolai", "Oleg", "Pavel",
    "Roman", "Sergei", "Stas", "Vadim", "Viktor", "Vladimir", "Yuri", "Anton", "Felix", "George",
    "Henry", "Jacob", "Jonah", "Leo", "Lucas", "Mark", "Max", "Nathan", "Oscar", "Paul",
    "Peter", "Robert", "Simon", "Theo", "Victor", "Hillel", "Elisha", "Gavriel", "Rafael", "Shmuel",
]

SURNAMES = [
    "Abergel", "Abutbul", "Adler", "Agmon", "Alon", "Alfasi", "Almog", "Amsalem", "Arbel", "Ashkenazi",
    "Atias", "Avidan", "Avital", "Avraham", "Azulai", "Bachar", "Banai", "Bar", "Bar-On", "Baruch",
    "Ben-Ami", "Ben-Haim", "Ben-Shimon", "Ben-Zvi", "Berger", "Bergman", "Blum", "Brener", "Buskila", "Chen",
    "Cohen-Tzedek", "Dagan", "Dayan", "Elias", "Eliyahu", "Erez", "Farhi", "Feldman", "Fischer", "Fried",
    "Gabay", "Gafni", "Galili", "Ganor", "Gershon", "Gil", "Ginsburg", "Glick", "Goldberg", "Goldstein",
    "Gordon", "Greenberg", "Gross", "Hadad-Levi", "Halevi", "Harari", "Hazan", "Hen", "Herzog", "Hoffman",
    "Horowitz", "Israeli", "Kaplan", "Karmi", "Kedem", "Keren", "Kimchi", "Kraus", "Kurtz", "Landau",
    "Lavi", "Lerner", "Lev", "Levin", "Levinson", "Lieberman", "Lipman", "Malka", "Margalit", "Meir",
    "Melamed", "Mor", "Moshe", "Nachum", "Nahmias", "Naor", "Nir", "Ofek", "Oren", "Ovadia",
    "Peled", "Perl", "Pinto", "Rabin", "Rahamim", "Raz", "Regev", "Reich", "Ronen", "Rothman",
    "Sabag", "Saban", "Sadeh", "Salomon", "Schwartz", "Sela", "Shalev", "Shamir", "Sharabi", "Sharon",
    "Shemesh", "Shimoni", "Shoham", "Shtern", "Shulman", "Sivan", "Sofer", "Stein", "Tamir", "Tzur",
    "Vaknin", "Weinberg", "Yadin", "Yaron", "Yosef", "Zaken", "Zamir", "Zilber", "Zohar", "Zur",
    "Abbas", "Abu-Ras", "Asadi", "Awad", "Bishara", "Daher", "Darwish", "Diab", "Ghanem", "Habib",
    "Haj", "Hamdan", "Hassan", "Hijazi", "Ibrahim", "Jaber", "Jabarin", "Kanaan", "Karam", "Kassem",
    "Khalil", "Khatib", "Mahameed", "Masri", "Mukhtar", "Nasrallah", "Odeh", "Qasem", "Rizk", "Saad",
    "Sabbagh", "Saleh", "Salman", "Shehadeh", "Suleiman", "Toma", "Yassin", "Zahran", "Zoabi", "Zidan",
    "Antonov", "Belov", "Fedorov", "Gurevich", "Ivanov", "Kogan", "Kuznetsov", "Lazarev", "Morozov", "Novak",
    "Orlov", "Pavlov", "Petrov", "Rabinovich", "Sokolov", "Volkov", "Zaitsev", "Brown", "Clarke", "Evans",
    "Wilson", "Taylor", "Moreno", "Costa", "Rossi", "Haim", "Ezer", "Tzadok", "Yehezkel", "Mazor",
]
