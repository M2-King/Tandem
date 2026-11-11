// A small practice database (a made-up school) and a file of exercises for
// it, so there is something to query straight away. All names and data are
// invented for practice.

export const PRACTICE_DB = 'practice.db';
export const PRACTICE_SQL = 'practice.sql';

export const PRACTICE_SCHEMA = `
CREATE TABLE departments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  building TEXT
);

CREATE TABLE teachers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  hired_on TEXT
);

CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER CHECK (year BETWEEN 1 AND 4),
  city TEXT,
  email TEXT UNIQUE
);

CREATE TABLE courses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  credits INTEGER NOT NULL,
  department_id INTEGER REFERENCES departments(id),
  teacher_id INTEGER REFERENCES teachers(id)
);

CREATE TABLE enrolments (
  student_id INTEGER REFERENCES students(id),
  course_id INTEGER REFERENCES courses(id),
  term TEXT NOT NULL,
  grade REAL,
  PRIMARY KEY (student_id, course_id, term)
);

INSERT INTO departments (id, name, building) VALUES
  (1, 'Computing', 'Block A'),
  (2, 'Mathematics', 'Block B'),
  (3, 'Business', 'Block C'),
  (4, 'Design', 'Block D');

INSERT INTO teachers (id, name, department_id, hired_on) VALUES
  (1, 'Aisha Rahman', 1, '2018-03-01'),
  (2, 'Daniel Ong', 1, '2021-08-16'),
  (3, 'Priya Nair', 2, '2015-01-05'),
  (4, 'Marcus Lee', 3, '2019-07-22'),
  (5, 'Sofia Tan', 4, '2022-02-14'),
  (6, 'Hafiz Ismail', 2, '2020-09-01');

INSERT INTO students (id, name, year, city, email) VALUES
  (1, 'Ali Hassan', 1, 'Kuala Lumpur', 'ali.h@student.example'),
  (2, 'Mei Ling', 2, 'Petaling Jaya', 'mei.l@student.example'),
  (3, 'Ravi Kumar', 3, 'Subang Jaya', 'ravi.k@student.example'),
  (4, 'Nur Izzah', 1, 'Shah Alam', 'nur.i@student.example'),
  (5, 'Jason Lim', 4, 'Kuala Lumpur', 'jason.l@student.example'),
  (6, 'Farah Aziz', 2, 'Penang', 'farah.a@student.example'),
  (7, 'Kevin Chong', 3, 'Petaling Jaya', 'kevin.c@student.example'),
  (8, 'Siti Aminah', 1, 'Johor Bahru', 'siti.a@student.example'),
  (9, 'Arjun Das', 2, 'Kuala Lumpur', 'arjun.d@student.example'),
  (10, 'Chloe Wong', 4, 'Subang Jaya', 'chloe.w@student.example'),
  (11, 'Amir Zaki', 3, 'Shah Alam', 'amir.z@student.example'),
  (12, 'Grace Teoh', 1, 'Penang', NULL);

INSERT INTO courses (id, code, title, credits, department_id, teacher_id) VALUES
  (1, 'CS101', 'Programming Fundamentals', 4, 1, 1),
  (2, 'CS205', 'Databases', 4, 1, 2),
  (3, 'CS310', 'Ethical AI', 3, 1, 1),
  (4, 'MA110', 'Calculus I', 4, 2, 3),
  (5, 'MA220', 'Statistics', 3, 2, 6),
  (6, 'BU150', 'Introduction to Marketing', 3, 3, 4),
  (7, 'DE120', 'Visual Design', 3, 4, 5),
  (8, 'CS330', 'Machine Learning', 4, 1, NULL);

INSERT INTO enrolments (student_id, course_id, term, grade) VALUES
  (1, 1, '2026-S1', 78), (1, 4, '2026-S1', 65), (1, 7, '2026-S1', 82),
  (2, 1, '2025-S2', 91), (2, 2, '2026-S1', 88), (2, 5, '2026-S1', 74),
  (3, 2, '2025-S2', 69), (3, 3, '2026-S1', 85), (3, 8, '2026-S1', NULL),
  (4, 1, '2026-S1', 58), (4, 6, '2026-S1', 71),
  (5, 3, '2025-S2', 93), (5, 8, '2026-S1', 89), (5, 5, '2025-S1', 77),
  (6, 4, '2026-S1', 81), (6, 5, '2026-S1', 86),
  (7, 2, '2026-S1', 72), (7, 3, '2026-S1', 64), (7, 6, '2025-S2', 55),
  (8, 1, '2026-S1', 47), (8, 7, '2026-S1', 90),
  (9, 1, '2025-S2', 83), (9, 2, '2026-S1', 79), (9, 4, '2026-S1', 70),
  (10, 3, '2026-S1', 95), (10, 8, '2026-S1', 92), (10, 6, '2025-S1', 68),
  (11, 5, '2026-S1', 61), (11, 2, '2025-S2', 76);
`;

export const PRACTICE_EXERCISES = `-- SQL practice: a small school database (practice.db).
-- Tables: departments, teachers, students, courses, enrolments.
-- Select one query (or put the cursor in it and select the lines) and press
-- Ctrl/Cmd+Enter, or ▶ Run to run the whole file. Click a table on the left
-- to see what is in it.

-- 1. Every student, newest year first.
SELECT name, year, city FROM students ORDER BY year DESC, name;

-- 2. Students from Kuala Lumpur or Penang.
SELECT name, city FROM students WHERE city IN ('Kuala Lumpur', 'Penang');

-- 3. How many students are in each year?
SELECT year, COUNT(*) AS students FROM students GROUP BY year ORDER BY year;

-- 4. Each course with its teacher (courses without a teacher too).
SELECT c.code, c.title, t.name AS teacher
FROM courses c
LEFT JOIN teachers t ON t.id = c.teacher_id;

-- 5. Average grade per course, best first (ungraded rows are ignored).
SELECT c.code, ROUND(AVG(e.grade), 1) AS average, COUNT(e.grade) AS graded
FROM courses c
JOIN enrolments e ON e.course_id = c.id
GROUP BY c.id
ORDER BY average DESC;

-- 6. Students who scored above 85 in any course.
SELECT DISTINCT s.name
FROM students s
JOIN enrolments e ON e.student_id = s.id
WHERE e.grade > 85;

-- Your turn:
-- 7. Which students have no email address?
-- 8. Which department teaches the most credits in total?
-- 9. Students taking more than two courses (hint: GROUP BY ... HAVING).
-- 10. Add yourself as a student, enrol in CS205 for 2026-S2, then check it worked.
`;
