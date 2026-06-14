(define (domain deliveroo-handoff)
  (:requirements :typing :action-costs)
  (:types location parcel)
  (:predicates
    (at-llm ?l - location)
    (at-bdi ?l - location)
    (carrying-llm ?p - parcel)
    (carrying-bdi ?p - parcel)
    (parcel-at ?p - parcel ?l - location)
    (handed-off ?p - parcel)
    (delivered ?p - parcel)
    (is-delivery ?l - location)
    (is-drop ?l - location))
  (:functions
    (distance ?l1 ?l2 - location)
    (total-cost))

  ;; LLM agent walks to the chosen drop point.
  (:action move-llm
    :parameters (?from ?to - location)
    :precondition (at-llm ?from)
    :effect (and
      (not (at-llm ?from))
      (at-llm ?to)
      (increase (total-cost) (distance ?from ?to))))

  ;; BDI agent walks to retrieve the handed-off parcel and/or to a delivery tile.
  (:action move-bdi
    :parameters (?from ?to - location)
    :precondition (at-bdi ?from)
    :effect (and
      (not (at-bdi ?from))
      (at-bdi ?to)
      (increase (total-cost) (distance ?from ?to))))

  ;; LLM drops the carried parcel at a non-delivery tile — this IS the handoff.
  (:action handoff-drop
    :parameters (?p - parcel ?l - location)
    :precondition (and (at-llm ?l) (carrying-llm ?p) (is-drop ?l))
    :effect (and
      (not (carrying-llm ?p))
      (parcel-at ?p ?l)
      (handed-off ?p)))

  ;; BDI picks up the parcel the LLM left behind.
  (:action bdi-pickup
    :parameters (?p - parcel ?l - location)
    :precondition (and (at-bdi ?l) (parcel-at ?p ?l))
    :effect (and
      (not (parcel-at ?p ?l))
      (carrying-bdi ?p)))

  ;; BDI delivers it.
  (:action bdi-deliver
    :parameters (?p - parcel ?l - location)
    :precondition (and (at-bdi ?l) (carrying-bdi ?p) (is-delivery ?l))
    :effect (and
      (not (carrying-bdi ?p))
      (delivered ?p))))
